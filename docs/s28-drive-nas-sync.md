# S28 OS 到云盘表格与 NAS 的增量推送（第一版）

## 一、一句话
OS 只是小测试环境，云盘表格和 NAS 才是销售真实在用的。所以这个推送程序只做三件小事，别的一概不碰：
1. 把 OS 里的 Meta 编号总表镜像到表格「NEWME OS – Meta IDs」（这张表是 OS 专用的，销售不填）。
2. 把广告点击编号 ctwa_clid 写进销售表「NewME」的「Home-owners」页 **X 列（meta_wa_ctwa_clid）** 的对应行，**只写这一个格子**。
3. 把每次改动的记录追加到 NAS，并每晚对一次账。

## 二、程序和运行方式
- 程序：`scripts/os-drive-nas-sync.mjs`；纯函数在 `src/lib/os-drive-sync.mjs`；谷歌表格客户端在 `src/lib/google-sheets-client.mjs`（由 tools/gsheet.mjs 扩展，无第三方依赖，用服务账号）。
- 单元：`infra/os-drive-sync/` 下 `newme-os-drive-sync.service/.timer`（每 5 分钟）、`newme-os-drive-reconcile.service/.timer`（每晚迪拜 02:30，在 02:10 的 Meta 编号导出之后）、`os-drive-sync.env.example`。
- **默认关闭**：`OS_DRIVE_SYNC_ENABLED` 不是 true 时，真正运行什么都不做（`--dry-run` 只读，不受开关影响）。单元按仓库的 after-flag 惯例只提供模板，不安装。
- 运行用户 root（要读 /etc/newme 下的服务账号密钥和 NAS 账号），在 /opt/newme/current 下运行，沿用 whatsapp-capi-send 的 EnvironmentFile 做法读 Supabase（服务角色，只读查询）。
- 命令行：`--dry-run`（只打印计划）、`--reconcile`（对账）、`--full`（忽略游标全量比对，只写有差异的格子）、`--max-writes N`（默认 200）、`--leads-file`（只用于试运行的假数据）。
- 不新增任何数据库迁移：只用现有表 leads、whatsapp_capi_events、meta_crm_stage_events 的 updated_at / created_at / delivered_at 做游标。

## 三、每 5 分钟做什么
1. 读游标文件（`/var/lib/newme-os-drive-sync/state.json`，原子写：临时文件→落盘→改名，0600）。游标是 leads.updated_at 的水位线，查询时往前多留 120 秒重叠，重复读到的行靠“只写有差异的”保持幂等。
2. 找出变化的线索：updated_at 晚于游标的；回传事件（两张事件表）新建或送达时间晚于游标的线索（回传状态变化不会改 leads.updated_at，所以要单独查）；上一轮没匹配上的点击编号线索（最多保留 14 天）。
3. 读两张表格（Meta 编号表读 A:O 一次；只有存在点击编号线索时才读 Home-owners 的 P、X 两列一次），算出计划。
4. **A：Meta 编号表**：按 (lead_ref, meta_id_type, meta_id) 对号入座。有变化的行原地更新（一次 batchUpdate），新的行追加（一次 append），**从不删行、从不清空**；表头必须与 META_IDS_HEADER 完全一致，否则拒绝写。
5. **B：销售表 X 列**：取线索电话，规范化成统一号码（去掉 `p:`、+、00，本地写法补 971，与数据库 wa_phone_key 一致），在 P 列找同一号码的行。找到且 X 格为空，或里面还是本程序之前写入的值（状态文件按线索记着我们写过什么）才写，**只写 X{行}**；没有对应行的只在报告里列出，**绝不新建行**；同一号码在表里出现多行的视为“有歧义”，不写，只报告。写之前要求第 1 个数据行表头 P=phone、X=meta_wa_ctwa_clid，对不上就整次拒绝。X 格里已有别的内容（人工手填）时 **跳过并在报告里计数，绝不覆盖**（Sam 11-20 确认）；NAS 记录里也不再保存任何旧值。
6. **总闸**：计划写入格数超过 `--max-writes`（默认 200）时，一个格子都不写、游标不动、退出码非零。首次回填更多行时由人显式加大。
7. **写后核对**：每批写完立刻读回同一范围逐格比较；不一致则只重写不一致的部分再读一次；仍不一致则记录并以非零退出，游标不前进。
8. **谷歌限流**：429 和 5xx 及网络错误指数退避加随机抖动（尊重 Retry-After），每次运行有请求数预算（默认 40），超了就停。
9. **写保护层**（最后一道闸）：所有写入都经过白名单包装：销售表只允许 Home-owners 页的单个 X 格、第 2 行以后、不允许追加；Meta 编号表只允许 A:O、第 2 行以后；任何别的表一律拒绝。测试覆盖这一层。
10. **NAS**：本地先追加到 `/var/lib/newme-os-drive-sync/changes/YYYYMMDD.jsonl`（迪拜日期，记录里没有电话号码，只有 lead_ref、行号、编号），再用现有 `newme-nas-upload.sh --overwrite` 把当天文件整体传到 `/newme-os-backup/exports/changes/`（NAS 接口只能整文件上传，不能追加，所以是“本地追加、整文件覆盖上传”）；上传失败不影响表格写入，下一轮自动重传。
11. 最后才保存游标和状态。连续失败计数：第 3 次连续失败才以非零退出触发告警（之后每 3 小时一次）；读回不一致、超过总闸、表头变了这三类硬错误立即非零退出。

## 三之二、来源标记（Sam 11-20 新增：写进云盘的每个格子都能追溯）
- **X 列**：程序每写一个格子，**同一次请求里**同时设浅蓝底色和批注：`OS 同步 迪拜时间 yyyy-mm-dd hh:mm｜来源：OS｜线索 NM-xxxx****`（只有线索编号前缀加星号，不含电话）。
- **Meta 编号表（OS 专用）**：表头 A1 加批注“本表全部由 OS 自动写入，请勿手改”（只写一次）；新增或更新的行整行浅蓝；更新过的格子批注为 `OS 更新 迪拜时间 … ｜上次 …`（记上一次同步时间，首次为“首次”），没变的格子不动批注。
- **人工改过的格子**：X 格现值不是空、也不是程序上次写入的值时，一律跳过不覆盖，**不做任何格式或批注写入**（Sam 11-20 决定：现阶段只区分“OS 写入的”）。只在汇总和对账报告里计数（`x_manual_skipped` / `manual_value_skipped`），并在 NAS 变更日志记一条 `skipped_manual_value`（只有行号和线索编号，不含格子内容；同一个人工值只记一次）。
- **白名单**：格式和批注请求单独一个入口，只允许落在“本来就允许写”的格子上（销售表只有 X 列的数据行；Meta 编号表只有 A:O 的数据行，外加 A1 那一条表头批注）；整行、别的列、表头、别的页、任何其他类型的格式请求（字体、删除、合并等）一律拒绝。测试覆盖。
- **读回校验**：写完立即逐格读回，比较**值、底色、批注**三项，不一致只重写不一致的再读一次，仍不一致就硬错误退出、游标不前进。
- **NAS 日志**：蓝色写入、表头批注、跳过的人工值都记入变更日志（含批注文字，无电话）。
- **兜底**：服务账号在谷歌版本历史里本来就显示为编辑者，任何一格是谁、何时改的都可在“版本历史”里查到，批注和底色只是让人一眼看出来。

## 四、每日全量快照
沿用已有的 `infra/meta-ids/newme-meta-ids-export.sh`（每天 02:10 把 Meta 编号总表 CSV 推到 NAS /newme-os-backup/exports/meta-ids-YYYYMMDD.csv，并在服务器本地 /var/lib/newme-meta-ids 留 60 天）。本程序不重复做，对账时直接读这份本地副本（与推到 NAS 的内容相同）。

## 五、每晚对账（--reconcile）
全量读 OS，对比：OS 与表格的行数、缺行、过期行、表格里多出的行、重复键；OS 与最新那份每日快照（行数，快照里有而 OS 没有的行）；Home-owners 的点击编号覆盖（已有、待写、没匹配、有歧义、因人工手填而跳过的数量）；工作程序健康度（最近成功时间、连续失败次数、待匹配数量）。报告是纯文本，写到 `/var/lib/newme-os-drive-sync/reports/reconcile-YYYYMMDD.txt`（0600），只有数字和少量 lead_ref，没有电话。Meta 编号行数对不上、最近成功超过 60 分钟、连续失败 ≥3 或 NAS 有未确认日子时退出码非零；点击编号没匹配进 X 列（没匹配、有歧义、手填跳过、待写入）只算警告，写进报告和日志，退出码为 0（单元带 OnFailure 告警）。

## 六、安全与隐私
- 不在日志、报告、NAS 记录里出现密钥、电话、完整点击编号以外的个人信息；失败只打印错误代码。
- 服务账号密钥放 /etc/newme/google-sheets-sa.json（root 0600），不进 git。需要把销售表对服务账号开“编辑者”才能写 X 格——这一步由 Sam 授权（现在服务账号已可读两张表）。
- 回退：停掉两个定时器即可；Meta 编号表是 OS 专用的，可用 `tools/gsheet.mjs put` 恢复成只有表头；X 列只会写进空格或本程序自己写过的格子，需要时按 NAS 记录里的行号清空即可。

## 七、已知限制和后续
- 回传状态变成“失败”时没有时间戳，增量查不到，靠每晚对账提示、`--full` 补齐（后续可在事件表加 updated_at，需要迁移，暂不做）。
- 电话规范化后在 X 列所在页出现多行同号会跳过并报告（销售表现有 1 个重复号码）。
- 只比对到“最新每日快照”，没有从 NAS 下载校验（NAS 接口目前只做上传）。
- 点击编号以“同一电话最早的线索”为准。

## 八、审查修正（#551）
- **NAS 补传**：每次运行枚举全部日期的变更日志，凡 NAS 还没确认大小一致的都重传，跨午夜上传失败的前一天文件也会补上。
- **先记日志再做下一步**：Meta 表更新、追加、表头批注、销售表 X 格每一批写成功后立即追加到本地变更日志（并保存状态），之后的读回、下一张表出错也不会丢审计。
- **同一格两个编号**：一个电话格里两个号码分属不同线索、会对同一个 X 格写不同值时，整行都不写，报告为 `ambiguous_destination`，NAS 日志记 `skipped_ambiguous_destination`。
- **追加不盲目重试**：追加遇到网络错误或 5xx 时客户端不再自动重试（只对 429 重试）；程序重读表格，按键核对，只追加还缺的行，最多两轮，仍缺则报错；格式标记按重读到的实际行号写。

## 附：新线索自动追加到销售「Lead Register」（开关 `OS_DRIVE_REGISTER_APPEND_ENABLED`，默认关）
- 表：分配总表（与 S29 读的是同一份，id 见 `DEFAULTS.registerSheetId`）的「Lead Register」页，表头在第 5 行。只追加新行，**从不改、不删、不挪已有行**。
- 每次运行先读表头并按名字核对（`REGISTER_HEADER` 38 个列名必须各出现一次且顺序不变，末尾多列/空列允许）；不一致则一格不写，摘要里出 `register_header_mismatch`，退出码 1，S28 其余工作照常。
- 起点水位线：开关第一次打开的那次运行记下当时时间（`state.register_watermark`），之后只处理 `created_at` 晚于它的线索，**绝不回填旧线索**。预览可用 `--dry-run --register-since <ISO|now>`。
- 只处理未归档、来源为 Meta 表单/点击到 WhatsApp/官网/Instagram 的线索；从表格导入的线索（有 import_fingerprint 或 drive_sync.inserted_by）和手工来源（展厅、转介绍、自开发）不追加。
- 去重：先按 Master Lead ID，再按「Source lead ID」里的 Meta 线索号，再按「Primary phone」规范化后的电话；同一批里同电话只追加最早一条。已在表里（崩溃后重跑）的行只补色和 OS 标记，不再追加。
- 只写这些列：Master Lead ID、Received at（迪拜时间 `YYYY-MM-DD HH:mm`）、Intake channel（Meta 表单含 Instagram 表单线索都写 FB Form，点击到 WhatsApp 写 WhatsApp，官网写 Website）、Client、Primary phone、Email、Campaign、Ad。Assigned to、Dispatch status 等其余列全部留空给人。
- Master Lead ID：Meta 表单线索 `META-<meta_leadgen_id>`；点击到 WhatsApp `WA-NM-<线索号>`；其他 `OS-NM-<线索号>`（S29 的识别前缀新增了 `OS`）。追加后在 OS 线索上写 `raw_import_data.register_append`（行号、时间）并在 `import_fingerprint` 为空时填入该编号的指纹，S29 回读这一行时按指纹（其次 Meta 线索号、电话）匹配到同一条线索，不会新建重复线索。**不需要数据库迁移**。
- 标记：写入的每个格子浅蓝底 + 批注「OS 写入 迪拜时间 …｜来源：OS｜线索 NM-xxxx****」；没写的格子不上色。
- 安全：不使用 values.append：读整页，取“任一格非空”的最后一行，写到其后的明确空行（values.update 逐格），写前重读目标行，有非空格就拒绝；白名单只允许这些行的 8 个写入列，上色/批注同样只限这些格；单次最多追加 30 行（超过一行都不写并报 `register_cap_exceeded`），也计入 `--max-writes`；追加后重读整表核对位置、重复和每个格子的值；追加前先把待办写入 state，崩溃后下一轮据此认领、补色、补标记。
- 需要 Sam 授权：服务账号要对分配总表有「编辑者」权限（现在 S29 只读）。
