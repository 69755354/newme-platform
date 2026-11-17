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
| `ALERT_CHANNEL` | 默认 `whatsapp`；设为 `telegram`（另需 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`）可改回 Telegram，同样检查 HTTP 状态 |

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
