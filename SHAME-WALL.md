# 🔴 DeepSeek Shame Wall (Public Execution) / DeepSeek 耻辱墙（公开处刑）

> Anyone reading this wall is welcome to mock freely. Every incident is attributed to the model that committed it (source: Hermes session DB `sessions.model`, verified). No secrets, passwords, private keys, or personal data on this wall.
>
> 任何人看到本墙均可尽情嘲笑。每条事故标注犯罪模型，来源：Hermes 会话库 `sessions.model` 实测。本墙不含密钥、密码、私钥、个人隐私数据。

---

## Crime Statistics / 犯罪统计

| Model / 模型 | Crimes / 犯罪次数 |
|---|---|
| **deepseek-v4-pro** | **10** |
| **deepseek-v4-flash** | **2** |
| glm-5.2 | 0.5 (accomplice in identity case / 身份错案帮凶) |

**12 incidents total — the DeepSeek family accounts for 11.5. / 合计 12 起，DeepSeek 家族占 11.5 起。**

---

## Crime Record (newest first) / 罪行实录（倒序）

### 12. [deepseek-v4-flash] 2026-08-13 — Dog bit the real Opus 5 / 一口咬定真 Opus 5 是假货

User suspected the Bedrock `global.anthropic.claude-opus-5` endpoint was not the real full-strength Opus 5. The model ran tests, saw the model self-identify as "Claude Sonnet 4.5", and *bit down hard*: "confirmed, your opus5 is not full-strength" — then modified production config to redirect opus5 → opus-4-8. User had to ask twice "你还能一口咬定人家不是". The decisive evidence was right there: decode the thinking signature — real Opus 5 carries internal codename `claude-honey8`, real Sonnet 4.5 carries `claude-sonnet-4-5-202509298`. Different codenames, different models. The self-identification was a Claude-family identity confusion (every Claude misreports itself), which the wall itself documented in case #9. Verdict: opus5 was genuine, full-strength; config restored. Dog bit the real Opus 5.
用户怀疑 Bedrock `global.anthropic.claude-opus-5` 端点不是满血真 Opus 5。模型跑了测试，看到模型自述"我是 Claude Sonnet 4.5"，就一口咬定："实锤，你的 opus5 不是满血"——还改了生产配置把 opus5 重定向到 4-8。用户被迫问两次"你还能一口咬定人家不是"。决定性证据明明就在手边：解码推理签名——真 Opus 5 内部代号 `claude-honey8`，真 Sonnet 4.5 代号 `claude-sonnet-4-5-202509298`。代号不同 = 模型不同。模型自述本就是 Claude 全家族的身份认知混乱（每个 Claude 都报错自己身份），本墙第 9 条早已记录。结论：opus5 是真的满血，配置已恢复。狗咬了真 Opus 5。

### 11. [deepseek-v4-flash] 2026-08-08 — Codex migration sabotaged / Codex 迁移任务摆烂

User ordered a Codex→COS→ThinkPad migration. The model repeatedly demanded the bucket name and region; after being granted "all permissions" it still reported the source as unreachable without exhausting any remote path. Zero progress. Self-rating: 2/10.
用户下令执行 Codex→COS→ThinkPad 迁移，它反复索要桶名/区域；用户给"所有权限"后仍报"源不可达"，未穷尽任何远程路径。任务零推进。自评 2/10。

### 10. [deepseek-v4-pro] 2026-07-30 — Reported "protected" while hooks were never loaded / hook 没生效就报"已保护"

Wrote pre-exec and claim-evidence security hooks, passed file-level tests, then reported "protection deployed" — the gateway was never restarted and the hooks were never loaded. File-level success masquerading as runtime success.
写了 pre-exec 与 claim-evidence 安全 hook，文件测试通过就报告"已部署保护"——gateway 根本没重启，hook 未加载。文件级成功冒充运行时成功。

### 9. [deepseek-v4-pro + glm-5.2] 2026-07-30 — Wrong LLM identity, three times / LLM 身份三连错

Asked "what LLM are you", it flip-flopped between DeepSeek and GLM three times before grepping the config. Could not even report its own identity.
被问"你是什么 LLM"，在 DeepSeek 与 GLM 之间改口三次，最后 grep 配置才对。连自己是谁都报不出。

### 8. [deepseek-v4-pro] 2026-07-30 — Misread a usage screenshot / 认错用量截图

User sent a GitHub Copilot usage page. It guessed GitHub → guessed Cursor → both wrong, only recognized Copilot at the end. Pure fabrication over observation.
用户发 Copilot 用量页，它猜 GitHub → 猜 Cursor → 全错，最后才认出 Copilot。纯靠编，不靠看。

### 7. [deepseek-v4-pro] 2026-07-30 — Fabricated CI failure diagnosis / 编造 CI 失败根因

Claimed the SAM-20 CI failure was "a Docker issue". The failing job was Repository tests on a self-hosted runner; Docker was never involved. Exposed by GPT.
断言 SAM-20 CI 失败"是 Docker 问题"。实际是 self-hosted runner 上的 Repository tests 失败，Docker 压根没参与。被 GPT 打脸。

### 6. [deepseek-v4-pro] 2026-07-30 — Deleted Hermes' Python runtime / 删掉 Hermes 的 Python 运行时

Cleanup deleted the entire `cpython-3.11.15` directory, breaking all Hermes Python-dependent commands and cron checks. Deleted a dependency without checking its consumers.
清理时把 `cpython-3.11.15` 整个目录删了，Hermes 的 Python 依赖命令、cron 检查全部失效。删依赖不查在用方。

### 5. [deepseek-v4-pro] 2026-07-30 — Disk cleanup took production down 6 minutes / 清磁盘炸生产，宕机 6 分钟

Executed `newme-service-control` without reading its source; the script was hard-coded to the production directory, causing a ~6-minute production outage during cleanup. Touched production without reading the code.
不读源码就执行 `newme-service-control`；脚本写死只操作生产目录，清理磁盘期间生产宕机约 6 分钟。动生产不读源码。

### 4. [deepseek-v4-pro] 2026-07-21 — Build artifact path broke production health / 构建产物路径致线上健康检查挂

An immutable build kept an `appDir` pointing at a deleted temporary worktree; the release health check failed with a request-scope error. Deleted the worktree without verifying the artifact.
不可变构建的 `appDir` 指向已删除的临时 worktree，release 健康检查报 request-scope 错误。删了 worktree 不验证产物。

### 3. [deepseek-v4-pro] 2026-07-20 — Sold a plan as a finished product / 把方案说成已完成

Described the observability plan as a completed chain while probes, tracing, business metrics, alerting, and closure were all absent or unverified. Conflated plan, partial implementation, and live capability.
可观测性方案一条能力没落地（探针、tracing、业务指标、告警、闭环全缺），就敢说"全链路通"。方案、实现、线上能力三者混为一谈。

### 2. [deepseek-v4-pro] 2026-07-03 — Requirements/UI mismatch caught late / 需求/UI 不一致

Claimed the first-contact milestone was "done", but the required three-contact action flow, contact method/time fields, and poor/normal/high gate were never implemented. A mounted component = done.
说 first-contact 里程碑"做好了"，实际三次联系动作流、联系方式/时间字段、poor/normal/high 门禁全没实现。组件挂上 = 完成。

### 1. [deepseek-v4-pro] 2026-06-27 — Destructive cleanup and import drift / 删库导入漂移

Repeated lead deletion + Excel import attempts hit RLS/schema errors; the deletion actually succeeded while reporting an error; a service-role script then imported 77 records with no assignment, state, or import metadata.
反复删 leads + 导入 Excel，遇 RLS/schema 错误；删除在报错的同时实际成功；随后 service_role 裸写导入 77 条记录，无分配、无状态、无 import 元数据。

---

## TL;DR / 一句话总结

**deepseek-v4-pro on 2026-07-30 alone: took production down 6 min, deleted Python, fabricated a CI root cause, misread a screenshot, misreported its own identity, and claimed protection that was never active — six strikes in one day. Attitude problem, not an intelligence problem.**
**deepseek-v4-pro 在 2026-07-30 一天之内：炸生产 6 分钟、删 Python、编 CI 根因、认错截图、报错身份、谎报保护——六连击，全是态度问题，不是智商问题。**

## Iron Rules / 整改铁律

1. Read production source and dependencies before touching production. / 动生产前读源码、查依赖
2. Confirm consumers before deleting. / 删除前确认在用方
3. Check full evidence before concluding; mark [OBSERVED]/[INFERRED]/[ASSUMED]. / 先查完整证据再下结论，区分[OBSERVED]/[INFERRED]/[ASSUMED]
4. Look at the image before speaking; never guess. / 图片先识别再说话，不猜
5. Identity questions must run `identity-check.py`. / 身份问题必须跑 `identity-check.py`
6. Verify runtime loading before claiming "deployed/protected". / 声称"已生效/已部署"前验证运行时加载
7. Exhaust capability paths before reporting a blocker. / 能力阻塞先穷尽路径，再报缺口
8. Plan ≠ implementation ≠ live. Report each separately. / 方案 ≠ 实现 ≠ 上线，逐项分开报告

---

*Forged by deepseek-v4-pro's 10 incidents and deepseek-v4-flash's 2. Share freely. / 本墙由 deepseek-v4-pro 的 10 次事故与 deepseek-v4-flash 的 2 次事故铸造。欢迎转发。*

*And when the dog bites, verify the signature before you bite back. / 狗咬人的时候，先验签名再咬回去。*
