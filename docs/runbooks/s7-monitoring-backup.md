# 监控、告警、日志与备份运维手册（S7）

适用范围：生产服务器（app.newme.ae）。本文件只描述仓库里的资产如何工作、出事怎么办；主机上的安装步骤在发布协调员手里的 `S7-INSTALL.md`。
公开仓库：本文不含任何密钥、账号或客户数据，所有凭据都只写“存放位置”。

## 1. 一张表看懂：谁来发现什么

| 故障 | 谁发现 | 多久 | 通知谁 |
|---|---|---|---|
| 整台服务器 / 证书 / 域名 / nginx 挂了 | NAS 上的外部探测 `infra/uptime/external-probe.sh` | 每分钟，连续 2 次失败 | Telegram 告警群 |
| 本机探测自己卡住不跑了 | `l0-watchdog.sh`（每分钟，独立于探测的锁） + Sentry 定时签到“漏签” | 7 分钟 | Telegram 告警群 + Sentry |
| 线上出现任何**新**报错（服务端或浏览器） | Sentry 规则“Any NEW production error” | 5 分钟内 | 团队邮件 + 现有 Telegram 转发 |
| Meta 线索接口失败 | 每次失败都写“原因代码”到统一日志并进 Sentry | 实时 | 同上 |
| Meta 线索与系统入库对不上 | 每日对账 `newme-meta-reconcile.timer` | 每天 06:40（迪拜） | Telegram 告警群 |
| 生产登录→打开线索列表→打开一条线索→退出这条链路坏了 | 每日巡检 `scripts/synthetic-journey.mjs`（生产模式，不写业务数据；发布进行中自动跳过） | 每天 | Telegram 告警群（成功也发一条，连续两天没收到“通过”本身就是告警） |
| 完整流程（分配等写操作）坏了 | 同一脚本的预发布模式（只在预发布跑） | 每天 | Telegram 告警群 |
| 数据库备份失败 / NAS 没收到（任何失败路径） | `newme-db-backup.service`：脚本自己退出前告警 + systemd 的 `OnFailure` 兜底 | 每天 01:30（迪拜） | Telegram 告警群 |
| 备份定时器根本没跑 / 最新备份超过 26 小时 | `newme-backup-freshness.timer` | 每小时 | Telegram 告警群 |
| 备份其实恢复不出来 / 超过 35 天没有演练通过 | 每月恢复演练（本机一次性数据库；失败同样双重告警）+ 每小时新鲜度检查里的 35 天检查 | 每月 3 号 | Telegram 告警群 |

## 2. Sentry 定时签到为什么 10 月 27 日之后断了

结论（诚实版）：**证据已被 11 月 4 日 00:03（北京时间，即 11-03 16:03Z）的服务器重启清掉，下面是依据现象的最可能原因，不是当场抓到的。**

- 现象：Sentry 上最后一次签到恰好是 10/27 04:46:56Z（发版那一刻），之后 8 天一次都没有；本机状态文件却一直是“成功”。服务器 11/04 00:03（北京时间）重启后，签到立刻恢复（11/04 02:00Z 起每小时 30 次全部正常）。
- 机理：cron 用 `flock -n` 跑探测，上一次没结束就**静默跳过**本次。探测发现异常时会把 `incident-capture.sh` 放到后台运行，后台进程**继承了锁文件描述符**，而它里面的 `journalctl` / `top` / `systemctl` 没有任何超时。只要有一个命令卡住，锁就一直被占着，之后每 2 分钟的 cron 都在 `flock -n` 处悄悄退出——不发签到、不更新本机状态（所以状态还是旧的“ok”），也不报错。重启杀掉了卡住的进程，一切恢复。
- 与“Sentry 收到 202 却不记录”无关：202 是 Sentry 的正常应答，之所以没有记录是因为根本没有发送。
- 修复（都在仓库里）：
  1. `incident-capture.sh` 一开始就关闭继承来的描述符，并整体限时 90 秒；
  2. `l0-composite-probe.sh` 整体限时 100 秒（小于 cron 的 2 分钟间隔），并在每次跑完后写心跳文件 `/run/newme-l0.heartbeat`；
  3. 新增 `l0-watchdog.sh`（每分钟，不受那把锁约束）：心跳超过 7 分钟就通过**原有告警通道**发 Telegram；
  4. 外部探测（第 4 节）不依赖本机任何东西。
- 旧告警 JAVASCRIPT-NEXTJS-A（“Cron failure: health-check”，累计两万多次）在 Sentry 里已不在未解决列表中，下一次真的漏签会重新触发。

## 3. 把本机告警从私聊改发到 Telegram 群

本机所有告警（L0 探测、发版演练、看门狗、备份、对账）都走同一个提供者，接收方只由一个配置文件决定，**不需要改代码**。

1. Sam 新建一个 Telegram 群，成员：Sam + 至少一名备份负责人。把现有告警机器人加进群。
2. 取群编号（负数，超级群形如 `-100…`）：在群里发一条消息后，由协调员用机器人查询最近更新（不要把机器人口令贴到聊天里）。
3. 协调员按 `S7-INSTALL.md` 第 4 节修改 `/etc/newme/postdeploy-alert-provider-v1.json` 里的 `chat_id`（root 只读文件），然后运行 `node /opt/hermes-scripts/observability/newme-alert-provider-v1.mjs validate-config` 校验，再手动触发一次演练告警确认群里收到。
4. 注意：普通群升级为超级群后编号会变，需要同步更新。
5. 外部探测（NAS 上）和每日模拟巡检各有自己的环境文件，里面的 `TELEGRAM_CHAT_ID` 也要填同一个群。

## 4. 外部探测（放在公司 NAS 上，经 Tailscale）

- 脚本：`infra/uptime/external-probe.sh`（POSIX sh，NAS 的 busybox 也能跑），每分钟检查 `/login` 返回 200、`/api/health` 返回 200 且内容含 `"status":"ok"`。连续 2 次失败发“故障”，恢复发“恢复”；每天一次“探测在运行”的心跳，**连续两天没看到心跳就说明 NAS 这边的探测自己坏了**。
- 配置：`/etc/newme-uptime.env`（0600，样例见 `infra/uptime/newme-uptime.env.example`）。口令不出现在进程参数里。
- 没有 systemd 的 NAS：用 NAS 自带“计划任务”每分钟执行 `/usr/local/bin/newme-external-probe.sh`；有 systemd 就用 `newme-uptime.service/.timer`。
- NAS 型号未知，所以安装方式只给通用步骤；NAS 必须能出站访问 `https://app.newme.ae` 和 `api.telegram.org`。Tailscale 在这里的作用是让 NAS 和服务器互通以便备份回传，探测本身走公网（这样才能发现证书/域名/Cloudflare 问题）。

## 5. 每日巡检（生产不写业务数据，预发布完整流程）

脚本 `scripts/synthetic-journey.mjs`，由环境变量 `SYNTH_MODE` 选择模式（不设就是生产模式，最安全）。

**生产模式（每天一次）**：登录 → 打开线索列表 → 打开其中一条线索的时间线 → 退出。**不写任何业务数据**：不分配、不改阶段、不写备注（但登录本身会产生一条会话和一条登录审计，退出会吊销该账号的会话），所以**不需要生产里的测试线索，也不需要在生产建 QA 账号**；代码里生产模式除登录/退出外只有 GET 请求（测试里逐条断言）。返回内容只在内存里检查结构，不打印、不落盘；输出和告警里只有步骤名、HTTP 状态和版本号。
- 账号：用 **Release UAT 里 operator 角色的那个账号**（能读全部线索和线索时间线，又不是 admin/boss；不要用 admin、boss，sales 只能看到分给自己的线索）。口令单独放在下面的环境文件里，**不要去读发布门禁的凭据文件**；门禁轮换这个账号的口令后，必须同步更新 `/etc/newme/synthetic-prod.env`（否则巡检每天失败并告警，不会锁账号）。
- **与发布门禁互斥**：门禁的发布后浏览器验收用同一个账号登录，而巡检“退出”会吊销该账号的全部会话。所以巡检开始前对 `/run/lock/newme-production-release.lock` 做“试拿、立即放开”的非阻塞检查：门禁正在发布（含验收）就**跳过本次**，只记一行“发布进行中，跳过”，不当故障告警；巡检全程不持有这把锁（持有会让同时开始的发布因“另一个发布操作在进行”直接退出）。因此巡检只保留每天迪拜 07:00 一次，**不在每次发版后再跑**（门禁自己的发布后验收已覆盖）。
- 环境文件（0600，root）`/etc/newme/synthetic-prod.env`：`SYNTH_BASE_URL=https://app.newme.ae`、`SYNTH_QA_EMAIL`、`SYNTH_QA_PASSWORD`，以及 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。口令只存这里。

**预发布模式（完整流程，每天一次）**：`SYNTH_MODE=staging`，对**预发布**跑：登录 → 打开线索 → 把一条固定的标记测试线索分配给另一个测试账号 → 核对 → 分配回来 → 退出。预发布模式**只允许**环境变量 `SYNTH_STAGING_HOSTS` 里列出的主机名（白名单，必须是普通主机名；写成生产域名、带结尾点的名字或 IP 都会被拒绝）。
- 预发布里准备：两个测试账号（一个 operator 登录并分配，一个销售被分配）；一条标记线索（姓名固定为一眼看出是测试的长名字，来源用预发布里**已有的合法来源**，例如 `other`，电话用不存在的号码，不带 Meta 线索编号）。生产不建这些。
- 改阶段：生产的业务规则只允许阶段**往前走**（`transition_lead_stage`，离开“新”还要求至少一条完整联系记录且已评估质量），所以脚本**从不尝试还原阶段**。需要验证改阶段时设置 `SYNTH_ONEWAY_STAGE=1`（默认关闭）：它会把标记线索往前推一个阶段，**不会还原**，下次要换一条新的测试线索或在预发布重置；脚本发现已经在目标阶段会明确报“需要重置”，不会误报严重。
- 环境文件 `/etc/newme/synthetic-staging.env`：`SYNTH_MODE=staging`、`SYNTH_STAGING_HOSTS`（预发布主机名，逗号分隔）、`SYNTH_BASE_URL`（预发布地址）、`SYNTH_QA_EMAIL`、`SYNTH_QA_PASSWORD`、`SYNTH_LEAD_ID`、`SYNTH_LEAD_MARKER`、`SYNTH_LEAD_SOURCE`、`SYNTH_HOME_ASSIGNEE_ID`、`SYNTH_AWAY_ASSIGNEE_ID`、可选 `SYNTH_ONEWAY_STAGE`/`SYNTH_TO_STAGE`，以及告警群的两个变量。
- 写入前的安全门（代码强制）：线索编号写死；每次写之前核对“编号 + 标记姓名 + 标记来源 + 负责人必须是两个测试账号之一”，任何一项不符直接中止、一个字都不写；分配一旦做过，`finally` 里一定还原；还原失败发“严重”告警。

关于来源 `synthetic_qa`：本方案不再使用它（生产不建测试线索，预发布用已有合法来源）。统计流 S5 已在统计里排除该来源，保留无害，不需要改。

## 6. 数据库每日备份与恢复

- 备份：`infra/backup/newme-db-backup.sh`，每天 01:30（迪拜）。只读生产（pg_dump），范围：`public`、`auth`（账号，不含会话/一次性令牌）、`supabase_migrations`。读取 `/etc/newme/migration-db.url`（唯一的数据库连接串文件），连接串通过临时服务文件传给 pg_dump，**不出现在进程参数里**。
- 失败一定有人知道：脚本任何失败路径（转储过小、没有表数据、解密后行数对不上、密钥/连接串文件缺失或权限不对、意外退出、被终止）都会**先发告警再退出**；两个服务另有 systemd `OnFailure=newme-backup-alert@%n.service` 兜底（超时、被杀、起不来时脚本发不出的那类）。同一次失败可能收到两条，属正常。`--dry-run` 不发告警。
- 新鲜度检查：`newme-backup-freshness.timer` 每小时看最新一份**完整**备份（有校验和文件）是否在 26 小时内，没有或太旧就告警——专门抓“定时器本身没跑”。第一次备份成功之后再启用它。
- 残留清理：每次启动先删除 `.work.*`（可能含**明文**转储，进程被强杀时才会留下）和 `*.part` 中超过 1 天的，不碰正在跑的。
- 加密：AES-256，密钥文件 `/etc/newme/backup-encryption.key`（root 0600，至少 32 字节随机内容）。**密钥必须另存一份到离线的地方（不要只放在这台服务器和 NAS 上），否则备份可能无法打开。** 明文只存在于 0700 工作目录，加密后立即删除；加密文件会被当场解密校验一次（能列目录、各表行数一致）才算成功。
- 本地保留 30 天（至少保留最新 7 份），位置 `/root/claude-ops-backups/db-daily`（目录 0700，文件 0600）。
- 同步到 NAS：在 `/etc/newme/backup.env` 里填 `SYNC_TARGET`（rsync over ssh，经 Tailscale 主机名）和 `SYNC_SSH_KEY`。NAS 同步失败不影响本地备份，但会发告警（退出码 3）。NAS 上只需要一个只写目录的专用账号。
- 灾难恢复（新建一个空的 Supabase 项目后）：
  ```
  # 1. 解密（在可信机器上，密钥文件不要贴进聊天）
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:/path/to/backup-encryption.key \
    -in newme-prod-YYYYMMDDTHHMMSSZ.dump.enc -out restore.dump
  # 2. 校验清单
  pg_restore --list restore.dump | head
  # 3. 恢复到目标库（目标连接串放在 0600 文件里，用 PGSERVICEFILE 方式，别写在命令行）
  pg_restore --dbname="service=target" --no-owner --no-privileges restore.dump
  ```
  恢复后再按 `supabase/migrations` 校对迁移记录。生产回滚/恢复属于需要 Sam 确认的操作。
- 每月恢复演练：`infra/backup/newme-restore-drill.sh`，每月 3 号。它把最新备份恢复进**本机一次性的 PostgreSQL 17**，逐表核对行数是否与备份时记录的一致，然后停掉并删除这个实例。**生产数据不出服务器，不进预发布项目，不需要为此征求任何人同意；也不再需要任何数据库连接串。**
  1. 一次性实例只监听 Unix 套接字（`listen_addresses=''`，不开任何端口），以 `postgres` 系统用户运行，数据目录在服务的私有 `/tmp`（`PrivateTmp=true`，服务结束或被杀时 systemd 一并清掉），内存/落盘参数调小（`shared_buffers=128MB`、`fsync=off`、`max_connections=5`）。
  2. 脚本开头清掉所有 `PG*` 环境变量，所有连接都用 `-h <套接字目录>`；连上后核对 `data_directory` 等于自己的数据目录且 `inet_server_addr()` 为空（证明是套接字连到自己的实例），否则拒绝并停库。“连到生产”在结构上不可能：没有网络连接。
  3. 恢复前先建 `anon`、`authenticated`、`service_role`、`supabase_auth_admin` 四个不能登录的角色，以及 `extensions` 模式和 `uuid-ossp`、`pgcrypto` 两个扩展（转储的行级规则引用这些）。
  4. `pg_restore` 用合法参数（遇错默认继续，不带 `--exit-on-error`）；报错按类别（去掉引号里的名字）计数写入日志，只有 `schema "X" already exists` 在允许清单内；出现清单外的类别会发“恢复有未预期报错”的告警，但**以逐表行数核对为通过标准**。第一次真跑时看一眼日志，把确认无害的类别加进 `DRILL_ALLOWED_ERRORS`。
  5. 结束时 `pg_ctl -m immediate stop`、删除整个目录，并确认目录已不存在；删不掉发“严重”告警并让演练失败。
  6. 演练通过会写时间戳文件；每小时的新鲜度检查在时间戳存在（或 `backup.env` 里设了 `DRILL_REQUIRED=1`）时要求它不超过 35 天，否则告警。
  失败会发告警，并有 systemd `OnFailure` 兜底。需要主机装 PostgreSQL 17 服务端程序（`apt install postgresql-17`，不建任何默认库，见安装文档第 9 节）。
- 干跑：两个脚本都支持 `--dry-run`（只检查配置、权限、备份文件，不连数据库、不启动实例）。

## 7. 日志保留与 Meta 回调日志

- 系统日志（含应用日志）保留 30 天：`infra/journald/50-newme-retention.conf`。
- nginx 访问日志保留 30 份（`/etc/logrotate.d/nginx` 的 `rotate 14` 改为 `rotate 30`，见安装步骤）。
- Meta 回调 `/api/meta/leadgen-webhook` 在 nginx 里有专用日志格式（`newme_meta_leadgen_v1`）：只记时间、请求编号、来源地址、方法、状态码、耗时，**不记请求行和查询参数**，错误日志丢弃；明文 80 端口直接返回 400，不重定向、不进通用日志。这样 `hub.verify_token` 不会再被写进日志。历史日志里已有的 4 行旧口令，只要口令更换（第 8 节），它们就是失效值，不需要删除历史日志。

## 8. 更换 Meta 回调验证口令（只写流程，本次不执行）

验证口令只在 Meta 订阅回调“验证并保存”那一步使用；日常收线索靠的是 App Secret 签名，**所以更换口令不会中断收线索**，前提是先改服务器再改 Meta 后台。
1. 协调员用 root 备份 `/etc/newme/newme-runtime.env`（放 `/root/claude-ops-backups`，0600）。
2. 用一段不回显的脚本生成新值并原子替换 `META_LEADGEN_VERIFY_TOKEN`；新值同时写入 root 专用文件 `/root/meta-verify-token.new`（0600），由 Sam 当面/加密渠道取走。**不要 echo，不要贴聊天。**
3. 通过 `newme-service-control` 重启应用（走正常流程，非发版）。
4. Sam 在 Meta 开发者后台 → Webhooks → 编辑回调，填入新口令并“验证并保存”（Meta 会调用 GET 验证，此时服务器已是新值）。
5. 在 Meta 的“线索测试工具”提交一条测试线索，确认入库（测试线索走隔离流程，不会回传转化）。
6. 删除 `/root/meta-verify-token.new`。失败回滚：把备份的 env 文件放回并重启，Meta 后台改回旧口令。

## 9. 每日业务提醒摘要（已准备，未启用）

接口 `/api/cron/daily-digest`（需要 `x-cron-secret`，且必须设置 `DAILY_DIGEST_ENABLED=true` 才会工作，否则返回 Disabled）。取代之前停用的“逾期跟进”和“告警”两项：
- 每人每天最多 1 条（稳定事件键 = 迪拜日期，数据库层面去重），管理员/老板再多 1 条团队汇总；
- 只有数量，没有客户姓名和联系方式；中英双语；没有逾期就不发；
- 旧接口 `check-alerts`、`check-overdue-followups` 保持停用，不要恢复。
启用前先在预发布演练一次，再由 Sam 同意后设置环境变量并加一条每天 09:00（迪拜）的调用。

## 10. 发给 Sentry 的内容：清洗到什么程度（如实说明）

服务端和浏览器的每条事件、每个性能事务在发出前都经过同一套清洗（`src/lib/observability.mjs`）：
- **整体删除**：请求体、Cookie、查询串、`Authorization` 等凭据头、用户邮箱/IP/用户名（只留用户编号）、栈帧里的局部变量（`vars`）、任何键名含 `query`/`statement`/`sql` 的字段（含 `db.statement`、`url.query`）、自定义 breadcrumb 的文字（只留类别、级别、时间，以及去掉查询串的网址/状态码）、界面点击和控制台行的内容。
- **按字段名遮盖**：`customer_name`、`fullName`、`note`、`address`、`whatsapp`、电话、邮箱等；在 `extra`、`tags`、自定义 `contexts`（非 SDK 自带的环境信息）里，连通用的 `name`、`customer`、`contact`、`owner` 之类键也一并遮盖。浏览器/系统/运行时这类 SDK 自带的 `contexts.browser.name` 等保留（那是产品名，不是人名）。
- **按格式遮盖**：邮箱、电话、令牌、`Bearer`、`password=`/`token=` 这类赋值后面的整行。
- **做不到的**：写在**报错信息、异常内容等自由文本里的姓名**无法识别（没有规则能认出一个名字），也不会被遮盖。这一条只能靠开发约定保证：**不要把客户姓名、备注、手机号拼进报错信息或日志文字里**，要写就只写线索编号。服务端性能事务有 10% 采样，其中数据库语句的字符串已按上面规则删除。
- 因此不能说“Sentry 里完全没有个人信息”，准确说法是：结构化字段里的个人信息已去除；自由文本里的姓名不能识别，靠不写入来保证。

## 11. 浏览器错误转发口 `/monitoring-tunnel`

不再使用 Sentry 插件的 `tunnelRoute`（它是普通反向代理：会把登录 Cookie 原样转给 Sentry，也能往任何 Sentry 项目投递）。现在是自写路由 `src/app/monitoring-tunnel/route.ts`（逻辑在 `src/lib/sentry-tunnel.mjs`）：
- 只收 POST，请求体最大 200KB，超出返回 413；
- 解析信封第一行里的 `dsn`，**主机和项目编号必须等于服务端环境变量 `SENTRY_DSN`（回退 `NEXT_PUBLIC_SENTRY_DSN`）里的值**（仓库里不写死），否则 403；
- 只转发到固定地址 `https://<该主机>/api/<项目编号>/envelope/`，只带请求体和固定的 `content-type`，**不转发** Cookie、Authorization、X-Forwarded-For 等任何入站头；5 秒超时；
- 浏览器端 `credentials: "omit"`（根本不带 Cookie），nginx 在 `location = /monitoring-tunnel` 里再清空 `Cookie`/`Authorization` 头并限制 256KB、仅 POST。
- 服务端必须能读到 `SENTRY_DSN`，否则该路由返回 503（浏览器错误不上报，不影响业务）。

## 12. 审计账号标识与导出审计

- 登录失败审计里的账号标识是带密钥的散列（HMAC-SHA256 取前 16 位），密钥来自服务端环境变量 `AUDIT_ACCOUNT_KEY_SECRET`（至少 16 字符，不进仓库）。**没有配置密钥时不写标识**（只写失败原因），绝不退回无盐散列。
- 数据导出审计覆盖：报价单 CSV 导出、线缆成本 Excel 导出（只记执行人编号、格式、档位，不记任何金额或数量）。

## 13. 需要并入数据库合并上线的方案（本 PR 不含迁移文件）

应用层已经记录：登录成功/失败、创建账号与指定角色、导出报价单。**直接改数据库里的角色**（不经过本应用）目前没有审计，需要一个触发器；它是新增迁移，必须并入统一的数据库发布：

```sql
-- Rollback: drop trigger profiles_role_audit on public.profiles; drop function public.audit_profile_role_change();
create or replace function public.audit_profile_role_change()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.role is distinct from old.role then
    insert into public.audit_logs (actor_id, action, target_type, target_id, details)
    values (auth.uid(), 'role_changed', 'user', new.id,
            jsonb_build_object('previous_role', old.role, 'new_role', new.role));
  end if;
  return new;
end $$;
revoke all on function public.audit_profile_role_change() from public, anon, authenticated;
drop trigger if exists profiles_role_audit on public.profiles;
create trigger profiles_role_audit after update of role on public.profiles
  for each row execute function public.audit_profile_role_change();
```
`audit_logs` 只记执行人编号，不记邮箱/姓名；`auth.uid()` 为空表示由服务端/控制台直接修改。
