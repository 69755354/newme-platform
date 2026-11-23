# S17 运行层就绪：定时任务、备份与 NAS 拉取、WhatsApp 告警

本文件只写原理、变量名和 Meta 后台要申请的内容；仓库是公开的，**这里没有也不应出现任何令牌、号码或编号**。主机上的逐步安装见发布协调员手里的 `S7-INSTALL.md`。

## 1. 定时任务（`infra/cron/`）

应用的定时接口都在 `src/app/api/cron/` 下，鉴权方式一致：请求头 `x-cron-secret` 必须等于应用的 `CRON_SECRET`（不符返回 401 或 403）。一个共用服务模板 `newme-cron@.service` 调用统一脚本 `newme-cron-call.sh <接口名>`：`curl --fail` 检查 HTTP 状态，失败退出码非 0，由 `OnFailure=` 触发 WhatsApp 告警；成功时发“恢复”（只有之前告过警才会真发）。

| 接口 | 迪拜时间 | 幂等 | 处理 |
|---|---|---|---|
| daily-reminder | 每天 08:00 | 是（每人每个迪拜日最多一条） | 安装并启用 |
| check-no-answer | 每天 08:10 | 是（只有出现更新的跟进记录才再提醒） | 安装并启用 |
| daily-funnel-snapshot | 每天 23:50 | 是（先删当天再写） | 安装并启用 |
| daily-digest | 每天 09:00 | 否 | 代码默认关闭；与 `DAILY_DIGEST_ENABLED=true` 一起启用，需 Sam 同意 |
| check-overdue-installments | 09:02 | 是 | **不装**：Hermes 已在每天 09:02 调用；不重复。只在 Hermes 停用那天替换用 |
| cleanup-notifications | 09:02 | 是 | **不装**：同上 |
| check-alerts | — | — | 代码里已停用（曾一次产生 432 条重复通知），**绝不启用** |
| check-overdue-followups | — | — | 同上 |

时间在单元里写成 `OnCalendar=*-*-* HH:MM:00 Asia/Dubai`，不依赖服务器本身的时区。`Persistent=true`：关机错过的，开机后补跑一次（接口幂等，所以安全）。

只有被拒绝连接（应用正在重启）才重试；收到任何 HTTP 回答后不重试，因为写入可能已经发生。

单元沙箱：`ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp`、空的能力集、只放行 AF_UNIX/INET/INET6，唯一可写目录是 `/var/lib/newme-alerts`。环境文件 `/etc/newme/cron.env`（只含 `CRON_SECRET` 与 `NEWME_CRON_BASE_URL`，root 0600）由 systemd 在沙箱建立之前读取，且不在 /home、/root 下，所以与沙箱不冲突；它刻意不读应用的运行环境文件（里面有数据库服务密钥）。

## 2. WhatsApp 告警（`infra/alerts/newme-whatsapp-alert.sh`）

调用方式沿用旧告警：`newme-whatsapp-alert.sh <键> <failure|recovery|info> <一行说明>`。发送方是公司现有的 WhatsApp Business 号码，经 Cloud API 的“已审批模板”主动发消息。退出码：0 已送达（或按规则无需发送）、1 送达失败、2 配置错误。判定送达看 HTTP 状态**和**返回里的消息编号；每次尝试在 `/var/lib/newme-alerts/alerts.log` 留一行，失败同时写到标准错误（进入 journal），绝不静默。故障同一个键在 `ALERT_REPEAT_HOURS`（默认 6）内不重复发；恢复只在之前真发过故障时才发。

配置放在主机 `/etc/newme/alerts.env`（属主运行用户，权限 600 或 400；权限不对脚本拒绝运行）：

| 变量 | 含义 |
|---|---|
| `ALERT_WHATSAPP_ACCESS_TOKEN` | 该 WhatsApp 商业账号的系统用户长期令牌（需要 `whatsapp_business_messaging` 权限） |
| `ALERT_WHATSAPP_PHONE_NUMBER_ID` | 公司现有号码的 `phone_number_id`（与 WhatsApp 试点渠道配置里是同一个编号） |
| `ALERT_WHATSAPP_RECIPIENTS` | 收件人，逗号分隔的国际格式号码（7 到 15 位数字，可带 +，与试点代码的号码规则一致）。Sam（主）+ Tanya（备份）。**只放主机，不进仓库** |
| `ALERT_WHATSAPP_TEMPLATE` | 模板名，默认 `newme_ops_alert` |
| `ALERT_WHATSAPP_LANGUAGE` | 模板语言，默认 `zh_CN` |
| `ALERT_WHATSAPP_API_VERSION` | 默认 `v26.0`（与现有审核工具一致） |
| `ALERT_STATE_DIR` / `ALERT_REPEAT_HOURS` | 默认 `/var/lib/newme-alerts` / `6` |
| `ALERT_CHANNEL` | 默认 `whatsapp`：先发 WhatsApp，**任何一位收件人没送达、或 WhatsApp 配置不全，就改走 Telegram 备用通道**；设为 `telegram` 则只发 Telegram。同样检查 HTTP 状态 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 可选。不填时，备用通道直接用发布门禁已经在用的那个机器人：读 `ALERT_TELEGRAM_PROVIDER_CONFIG`（默认 `/etc/newme/postdeploy-alert-provider-v1.json`）里的 `bot_token`、`chat_id` 两个键；文件必须是运行用户（root）所有、权限 400/600，否则不用 |

备用通道（2026-11-20 审计 F1：模板 `newme_ops_alert` 在号码所属商业账户里不存在，告警从没送达过）：WhatsApp 失败的每一条都照常记 `FAILED` 到 `alerts.log` 和标准错误，然后 Telegram 发同一条，正文末尾注明“WhatsApp 未送达，本条走 Telegram 备用通道”，日志记 `delivered via telegram (fallback)`。**两个通道都没送达才返回 1**；WhatsApp 配置不全且也没有 Telegram 可用时返回 2。备份脚本调用发送器时不再把输出丢掉：发送器的错误进 journal，发送失败再在 `alerts.log` 记一行 `FAILED sender exit N`，`newme-backup-alert@` 这个失败处理单元也会以 1 退出（在 `systemctl --failed` 里看得到）。

### 需要在 Meta 后台申请的模板

- 位置：Meta 商务管理平台 → WhatsApp 管理工具 → 消息模板 → 新建（所属账号是该号码所在的 WhatsApp 商业账号）
- 名称：`newme_ops_alert`
- 类别：**UTILITY（服务/实用）**
- 语言：中文（简体），代码 `zh_CN`
- 正文（3 个变量，开头结尾都不是变量）：
  `【NewMe 运维告警】状态：{{1}}。来源：{{2}}。详情：{{3}} 请及时查看。`
- 变量示例（审核时要填）：`{{1}}` = 故障；`{{2}}` = db-backup；`{{3}}` = database backup failed (exit 1)
- 变量取值：{{1}} 只会是 故障、恢复、通知；{{2}} 是告警键（字母数字和 `.-_`）；{{3}} 是单行说明，最长 400 字符，发送前已去掉换行、制表符和连续空格（模板参数不接受这些）
- 不加按钮、不加页眉页脚。
- 通过后用 `info` 事件发一条测试，两位收件人都要收到。

费用提示：WhatsApp 对商家主动发起的 UTILITY 模板按条计费（在 24 小时客户服务窗口内免费）。告警量很小；仍需账号已绑定付款方式，Sam 需知情。

## 3. 备份与 NAS 主动拉取

- 本机备份目录 `/var/backups/newme-db`（root:root 0700，文件 0600），不在 /root 下，因此 `ProtectHome=true` 的单元可以写。保留策略不变：30 天，且至少保留最新 7 份。
- 每次备份成功后，把加密文件复制一份到 `/var/backups/newme-db-pull`（root:newme-nas-pull 0750，文件 0640，随本地保留策略同步清理）。文件是 AES-256 加密的，密钥不在 NAS 上。
- 只读拉取账号 `newme-nas-pull`：`infra/backup/newme-nas-pull-setup.sh --pubkey-file <NAS 公钥> --from <NAS 公网地址>`。只能密钥登录（密码为 `*`）；authorized_keys 是 root 所有、账号自己改不了，条目为 `restrict,from="…",command="/usr/local/libexec/newme/newme-nas-rsync-ro.sh"`；强制命令只放行 `rsync --server --sender` 读取拉取目录，其余（上传、shell、scp、别的路径、`..`、`--delete`、`--remove-source-files`、`--rsync-path`）一律拒绝并记入 `refused.log`。账号对目录也没有写权限。不修改 sshd、sudoers、防火墙。
- NAS 每次拉取成功后，强制命令写 `/var/lib/newme-nas-pull/state/last-pull-ok`。把 `/etc/newme/backup.env` 里加上 `NAS_PULL_REQUIRED=1` 后，每小时的新鲜度检查在 NAS 超过 `NAS_PULL_MAX_AGE_HOURS`（默认 30）没有拉取时告警（键 `nas-pull-freshness`），并在恢复时发恢复消息。

## 4. 每周恢复演练、NAS 推送检查、Meta 回传定时任务（2026-11-20 审计 F3/F6、H1、M6）

这些文件现在都由发布门禁里的 `scripts/install-systemd-assets.sh` 安装，并在它的回退集合里（回退时恢复旧文件）：
发送器 `newme-whatsapp-alert.sh`、`newme-backup-lib.sh`、`newme-backup-onfailure.sh`、`newme-backup-freshness.sh`、`newme-restore-drill.sh`（装到 `/usr/local/libexec/newme/`），以及 `newme-restore-drill.service/.timer`、`newme-wa-capi-send.service/.timer`、`newme-meta-crm-send.service/.timer`（装到 `/etc/systemd/system/`）。

**恢复演练（每周）**：`newme-restore-drill.timer` 每周日 23:15 UTC（迪拜周一 03:15，晚于 21:30 UTC 的每日备份）。它需要 PostgreSQL 17 的**服务端**程序（`initdb`、`pg_ctl`），本机只有客户端。安装器不装系统包，这一步手工做一次（先关掉自动建库，免得 5432 上多出一个数据库）：

```bash
sudo mkdir -p /etc/postgresql-common/createcluster.d
echo 'create_main_cluster = false' | sudo tee /etc/postgresql-common/createcluster.d/no-main-cluster.conf
sudo apt-get install -y postgresql-17
sudo BACKUP_LIB=/usr/local/libexec/newme/newme-backup-lib.sh /usr/local/libexec/newme/newme-restore-drill.sh --dry-run
```

装好之后的下一次发布会自动 `enable --now` 这个定时器（安装器看到 `/usr/lib/postgresql/17/bin/initdb` 和 `pg_ctl` 才启用；没有就只装不启用，并打印提示）。也可以在装包后手动 `sudo systemctl enable --now newme-restore-drill.timer`。

新鲜度检查对演练的要求：通过标记 `/var/backups/newme-db/.restore-drill-last-pass` 最多 `DRILL_MAX_DAYS`（默认 9）天。**标记不存在不再跳过**：从 `DRILL_REQUIRED_FROM`（UTC 日期，默认 2026-12-01）起算失败并告警（键 `db-restore-drill-freshness`）；`DRILL_REQUIRED=1` 则立即要求。宽限期内只在 journal 记一行提示。

**NAS 推送检查**：`/var/lib/newme-nas-push` 存在（推送已安装）或 `NAS_PUSH_REQUIRED=1` 时，每小时检查 `last-ok`；超过 `NAS_PUSH_MAX_AGE_HOURS`（默认 26）或从没成功，就用独立的键 `nas-push-freshness` 告警，恢复后发恢复消息；不让检查单元本身失败（否则会换个键再发一遍）。

**Meta 回传**：
- `newme-wa-capi-send.timer`（点击 WhatsApp 广告的回传）原来只在主机上手工装过，现在收进仓库 `infra/systemd/`，内容与主机一致；安装器只更新文件，不改它是否启用。
- `newme-meta-crm-send.timer`（表单线索阶段回传，队列 `meta_crm_stage_events`）新增，写法与上面相同：每 10 分钟，`node scripts/meta-crm-events-send.mjs --execute`，失败走 `newme-unit-alert@`。安装器只在 `/etc/newme/newme-runtime.env` 或 `capi-wa.env` 里有 `META_PIXEL_ID` 和 `META_CAPI_ACCESS_TOKEN`（只看变量名有没有值，不读出值）时才启用，否则只装不启用并打印提示。
- 两个发送脚本的汇总都有 `exhausted`（重试 5 次仍没发出去、不会再被拾取的行），非零时以 1 退出，从而触发告警。

## 每日简报与未联系提醒（默认关闭）

- `newme-daily-brief.timer`：迪拜 08:05（UTC 04:05）发简报给 Sam 和 Tanya；`newme-lead-reminder.timer`：迪拜 09:00 到 21:00 每小时，给分配超过 24 小时仍无首次联系的销售发一条提醒（每人每天最多一条）。两者都走现有告警发送器和已批准模板，失败走 `newme-unit-alert@`。
- 开关在 `/etc/newme/daily-brief.env`（可选文件，不存在即关闭）：`NEWME_DAILY_BRIEF_ENABLED=true`、`NEWME_LEAD_REMINDER_ENABLED=true`。每次运行都重新读取，改完不用重启。
- 日报加"销售反馈待补"段（默认关）：`/etc/newme/daily-brief.env` 里加 `NEWME_BRIEF_FEEDBACK_SECTION_ENABLED=true`；按销售列出分配满 1 天仍未写 Day 1 反馈、分配满 3 天且最新反馈只是"未接"的线索数和最久几条编号。读表失败则该段省略，日报照发。
- 新表单线索即时跟进（默认关，计时器只安装不启用）：开关 `/etc/newme/speed-to-lead.env` 里 `NEWME_SPEED_TO_LEAD_ENABLED=true`；公司号发客户模板用 root 专属文件 `/etc/newme/customer-wa.env`（`CUSTOMER_WA_ACCESS_TOKEN`、`CUSTOMER_WA_PHONE_NUMBER_ID`，权限 0600）。启用：`systemctl enable --now newme-speed-to-lead.timer`。台账 `/var/lib/newme-speed-to-lead/ledger.json`（只含线索编号和次数）。
- 试运行（只读，只打印数量）：`node scripts/daily-brief.mjs --mode brief` 或 `--mode reminders`。
- 销售手机号取自 `profiles.phone`；没有手机号的人不发提醒，并在简报的“需要注意”里列出。
