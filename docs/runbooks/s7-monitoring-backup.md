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
| 登录→线索→分配→改阶段整条链路坏了 | 每日模拟巡检 `scripts/synthetic-journey.mjs` | 每天 | Telegram 告警群（成功也发一条，连续两天没收到“通过”本身就是告警） |
| 数据库备份失败 / NAS 没收到 | `newme-db-backup.service` | 每天 01:30（迪拜） | Telegram 告警群 |
| 备份其实恢复不出来 | 每月恢复演练 | 每月 3 号 | Telegram 告警群 |

## 2. Sentry 定时签到为什么 10 月 27 日之后断了

结论（诚实版）：**证据已被 11 月 4 日 00:03 的服务器重启清掉，下面是依据现象的最可能原因，不是当场抓到的。**

- 现象：Sentry 上最后一次签到恰好是 10/27 04:46:56Z（发版那一刻），之后 8 天一次都没有；本机状态文件却一直是“成功”。服务器 11/04 00:03 重启后，签到立刻恢复（11/04 02:00Z 起每小时 30 次全部正常）。
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

## 5. 每日模拟巡检（QA 账号 + 一条标记线索）

脚本 `scripts/synthetic-journey.mjs`，流程：登录 → 打开线索 → 分配给另一个 QA 账号 → 改阶段 → 全部还原 → 退出。

一次性准备（需 Sam 同意后由协调员在生产里建，之后永不改动）：
1. 两个 QA 账号：`qa-synthetic-a`（角色 operator，用于登录和分配）和 `qa-synthetic-b`（销售，作为被分配人）。不要用真人账号，不要给 admin。
2. 一条标记线索：姓名固定为一个一眼看出是测试的长名字（例如 `ZZ-QA-SYNTHETIC-DO-NOT-TOUCH`），来源为 `synthetic_qa`，电话用不存在的号码，**不带 Meta 线索编号**（这样改阶段不会向 Meta 回传转化事件）。它初始分配给 `qa-synthetic-a` 或 `b`，阶段为“新”。
3. 在业务报表里排除来源 `synthetic_qa`（统计流 S5 的口径需确认）。
4. 环境文件（0600，root）：`SYNTH_BASE_URL`、`SYNTH_QA_EMAIL`、`SYNTH_QA_PASSWORD`、`SYNTH_LEAD_ID`、`SYNTH_LEAD_MARKER`、`SYNTH_LEAD_SOURCE`、`SYNTH_HOME_ASSIGNEE_ID`、`SYNTH_AWAY_ASSIGNEE_ID`、可选 `SYNTH_TO_STAGE`，以及 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。

安全设计（代码里强制）：线索编号写死；每次写之前核对“编号 + 标记姓名 + 标记来源 + 负责人必须是两个 QA 账号之一”，任何一项不符直接中止、一个字都不写；任何失败都会走“还原”；还原失败发“严重”告警。输出和告警里只有步骤名、HTTP 状态和版本号，没有姓名、电话、口令、Cookie。

## 6. 数据库每日备份与恢复

- 备份：`infra/backup/newme-db-backup.sh`，每天 01:30（迪拜）。只读生产（pg_dump），范围：`public`、`auth`（账号，不含会话/一次性令牌）、`supabase_migrations`。读取 `/etc/newme/migration-db.url`（唯一的数据库连接串文件），连接串通过临时服务文件传给 pg_dump，**不出现在进程参数里**。
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
- 每月恢复演练：`infra/backup/newme-restore-drill.sh`，每月 3 号。它在**预发布** Supabase 项目里新建一个临时库 `drill_时间戳`，把最新备份恢复进去，逐表核对行数是否与备份时记录的一致，然后删除临时库。三道保护：目标连接串里必须出现预发布项目编号且不能出现生产项目编号；只动它自己新建的临时库，不碰预发布现有数据；备份文件的校验和必须先通过。失败会发告警。
- 干跑：两个脚本都支持 `--dry-run`（只检查配置、权限、目标是否安全，不连数据库）。

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

## 10. 需要并入数据库合并上线的方案（本 PR 不含迁移文件）

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
