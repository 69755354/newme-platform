# S29 云盘表格 → OS 读取同步（第一版）

## 一句话
每天两次（迪拜 02:30 夜间、13:00 白天）只读地读取云盘里的销售表和营销表，和 OS 对数，把销售写的每日跟进、下次行动、线索质量和理由补进 OS。**云盘文件一个字都不改**。

## 谁说了算（字段归属）
| 内容 | 谁说了算 | 同步怎么做 |
|---|---|---|
| 每日跟进文字（Day 1–5、后续记录）、下次行动、下次日期、线索质量与理由、联系备注 | 云盘/销售 | 云盘有值就写进 OS；**云盘是空的绝不清空 OS** |
| 线索编号、来源、广告/Meta 编号、在 OS 里设的负责人、阶段、里程碑、合同 | OS | 同步不改 |
| 两边都改了同一字段 | 谁修改时间晚听谁的 | 每次冲突写入同步日志（谁赢、哪个字段） |
| 已赢单/已丢单线索 | 阶段与结果不动 | 同步从不改阶段 |
| 已归档（冻结）线索 | 保持归档 | 记为“暂缓：archived_frozen”；只有开关 DRIVE_SYNC_ALLOW_UNARCHIVE=true 才取消归档 |
| 下次日期 | 默认只存进线索的原始数据与备注，不写线索的日期列 | 写日期列会触发数据库自动建跟进任务，所以由 DRIVE_SYNC_WRITE_NEXT_DATE 控制，默认关 |

5 天联系规则所需的输入（已填 Day 数、首次联系时间、联系规则）一并存进线索原始数据的 `drive_sync` 段，供后续规则使用。

## 读哪些表
Faizan（Leads）、Lead Allocation（Lead Register）、Assem（B2C、B2B）、Mohammed（Leads - Daily）、营销表（Home-owners、new form leads）。**营销表的“Lead Quality Feedback”页是脚本生成的报告，代码里写死拒绝读取**。项目/商机与拜访报告不在第一版范围（一次性回填已处理），后续版本再加。

## 怎么跑
```
node scripts/drive-to-os-sync.mjs --run-now                 # 预演（默认）：读表、向 OS 要计划、出报告，什么都不写
node scripts/drive-to-os-sync.mjs --run-now --apply         # 真写（通过 OS 接口写）
node scripts/drive-to-os-sync.mjs --run-now --offline       # 只读表，不连 OS（验证解析）
node scripts/drive-to-os-sync.mjs --run-now --os-snapshot 线索快照.json   # 用本地快照对数
```
手动“立即运行”就是带 `--run-now`；不带它脚本不会运行。定时用 `infra/drive-sync/` 里的一对 systemd 单元（`after-flag`：开关和 Sam 同意前不安装）。时间改 `.timer` 里的 `OnCalendar`；模式、令牌、上限改 `/etc/newme/drive-sync.env`（样例见 `drive-sync.env.example`）。

**首次真实运行必须先预演**：`DRIVE_SYNC_MODE` 默认是 `dry-run`，要看过报告再改 `apply`。

## 安全设计
- 读表用只读授权（spreadsheets.readonly + drive.metadata.readonly），只发 GET；谷歌那边本身也拒绝任何写入。
- 脚本不连数据库。写入只经 `POST /api/sync/drive-ingest`：默认关闭（`DRIVE_SYNC_INGEST_ENABLED=false` 时返回 503），要求令牌（≥32 位、常量时间比较）、限速（每来源每分钟 30 次）、每次最多 100 条、请求体 ≤2MB；请求不带 `dry_run:false` 一律当预演。
- 每次运行最多写 300 次（`--max-writes` / `DRIVE_SYNC_MAX_WRITES`）。计划超过上限时**一条都不写**，退出码 3。
- 幂等：每行云盘内容算一个哈希，上次同步后没变就是“无变化”，第二次运行写 0 条。
- 每个应用的改动都记在追加式日志 `…/sync-log.jsonl`（只有掩码编号、字段名、冲突结果，没有电话姓名）；同时在线索时间线里写一条来源为 `drive_sync` 的备注（用现有 activities 表，不需要迁移）。日志写不进去时接口拒绝写入（失败即停）。
- 写后核对：通知、任务、Meta 回传、WhatsApp 回传四张表的行数前后必须不变，变了就报异常。
- 新增线索（云盘有、OS 没有）默认**不建**，只在预演里列为“暂缓：insert_disabled”并计数；`DRIVE_SYNC_ALLOW_INSERT=true` 才建（阶段一律“新线索”，负责人留空）。

## 对账报告
每次运行在 `DATA_DIR/reports/` 生成纯文本报告：读取、匹配、新增、更新、无变化、跳过、暂缓、冲突、写入数；每个标签页读到的行数；未匹配/暂缓/冲突的行（只有“表名 + 行号 + 掩码编号 + 原因”，没有电话和姓名）；异常清单。**异常时退出码 2**：读取失败、列缺失/表头变了（该页跳过）、某页行数比上次骤降过半、接口失败、写后四表行数变化、有改动应用失败。

## 需要的后续（没做迁移）
1. 线索表正式的外部编号字段与同步状态列（现在借用导入指纹和 `raw_import_data.drive_sync`）。
2. 每行“最后修改时间”：云盘接口只给整份文件的修改时间，冲突判断用文件级时间，偏保守。
3. 下次日期写入线索列需先确认“自动建任务”是想要的行为。
4. 项目/商机、拜访报告的持续同步。
