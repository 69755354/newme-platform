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
5. **B：销售表 X 列**：取线索电话，规范化成统一号码（去掉 `p:`、+、00，本地写法补 971，与数据库 wa_phone_key 一致），在 P 列找同一号码的行。找到且 X 格为空或与我们的编号不同才写，**只写 X{行}**；没有对应行的只在报告里列出，**绝不新建行**；同一号码在表里出现多行的视为“有歧义”，不写，只报告。写之前要求第 1 个数据行表头 P=phone、X=meta_wa_ctwa_clid，对不上就整次拒绝。X 格里原来有不同内容时（覆盖）会计数并把旧值记入 NAS 记录，方便还原。
6. **总闸**：计划写入格数超过 `--max-writes`（默认 200）时，一个格子都不写、游标不动、退出码非零。首次回填更多行时由人显式加大。
7. **写后核对**：每批写完立刻读回同一范围逐格比较；不一致则只重写不一致的部分再读一次；仍不一致则记录并以非零退出，游标不前进。
8. **谷歌限流**：429 和 5xx 及网络错误指数退避加随机抖动（尊重 Retry-After），每次运行有请求数预算（默认 40），超了就停。
9. **写保护层**（最后一道闸）：所有写入都经过白名单包装：销售表只允许 Home-owners 页的单个 X 格、第 2 行以后、不允许追加；Meta 编号表只允许 A:O、第 2 行以后；任何别的表一律拒绝。测试覆盖这一层。
10. **NAS**：本地先追加到 `/var/lib/newme-os-drive-sync/changes/YYYYMMDD.jsonl`（迪拜日期，记录里没有电话号码，只有 lead_ref、行号、编号、旧值），再用现有 `newme-nas-upload.sh --overwrite` 把当天文件整体传到 `/newme-os-backup/exports/changes/`（NAS 接口只能整文件上传，不能追加，所以是“本地追加、整文件覆盖上传”）；上传失败不影响表格写入，下一轮自动重传。
11. 最后才保存游标和状态。连续失败计数：第 3 次连续失败才以非零退出触发告警（之后每 3 小时一次）；读回不一致、超过总闸、表头变了这三类硬错误立即非零退出。

## 四、每日全量快照
沿用已有的 `infra/meta-ids/newme-meta-ids-export.sh`（每天 02:10 把 Meta 编号总表 CSV 推到 NAS /newme-os-backup/exports/meta-ids-YYYYMMDD.csv，并在服务器本地 /var/lib/newme-meta-ids 留 60 天）。本程序不重复做，对账时直接读这份本地副本（与推到 NAS 的内容相同）。

## 五、每晚对账（--reconcile）
全量读 OS，对比：OS 与表格的行数、缺行、过期行、表格里多出的行、重复键；OS 与最新那份每日快照（行数，快照里有而 OS 没有的行）；Home-owners 的点击编号覆盖（已有、待写、没匹配、有歧义、会覆盖的数量）；工作程序健康度（最近成功时间、连续失败次数、待匹配数量）。报告是纯文本，写到 `/var/lib/newme-os-drive-sync/reports/reconcile-YYYYMMDD.txt`（0600），只有数字和少量 lead_ref，没有电话。出现差异、最近成功超过 60 分钟或连续失败 ≥3 时退出码非零（单元带 OnFailure 告警）。

## 六、安全与隐私
- 不在日志、报告、NAS 记录里出现密钥、电话、完整点击编号以外的个人信息；失败只打印错误代码。
- 服务账号密钥放 /etc/newme/google-sheets-sa.json（root 0600），不进 git。需要把销售表对服务账号开“编辑者”才能写 X 格——这一步由 Sam 授权（现在服务账号已可读两张表）。
- 回退：停掉两个定时器即可；Meta 编号表是 OS 专用的，可用 `tools/gsheet.mjs put` 恢复成只有表头；X 列的改动可依据 NAS 记录里的旧值还原。

## 七、已知限制和后续
- 回传状态变成“失败”时没有时间戳，增量查不到，靠每晚对账提示、`--full` 补齐（后续可在事件表加 updated_at，需要迁移，暂不做）。
- 电话规范化后在 X 列所在页出现多行同号会跳过并报告（销售表现有 1 个重复号码）。
- 只比对到“最新每日快照”，没有从 NAS 下载校验（NAS 接口目前只做上传）。
- 点击编号以“同一电话最早的线索”为准。
