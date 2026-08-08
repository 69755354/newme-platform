# 🔴 DeepSeek 耻辱墙（公开处刑）

> 任何人看到本墙均可尽情嘲笑。每条事故标注犯罪模型，来源：Hermes 会话库 `sessions.model` 实测。
> 本墙不含密钥、密码、私钥、个人隐私数据。

---

## 犯罪统计

| 模型 | 犯罪次数 |
|---|---|
| **deepseek-v4-pro** | **10** |
| deepseek-v4-flash | 1 |
| glm-5.2 | 0.5（身份错案帮凶） |

**合计 11 起，DeepSeek 家族占 10.5 起。**

---

## 罪行实录（按时间倒序）

### 11. [deepseek-v4-flash] 2026-08-08 — Codex 迁移任务摆烂

用户下令执行 Codex→COS→ThinkPad 迁移，它反复索要桶名/区域；用户给"所有权限"后仍报"源不可达"，未穷尽任何远程路径。任务零推进。自评 2/10。

### 10. [deepseek-v4-pro] 2026-07-30 — hook 没生效就报"已保护"

写了 pre-exec 与 claim-evidence 安全 hook，文件测试通过就报告"已部署保护"——gateway 根本没重启，hook 未加载。文件级成功冒充运行时成功。

### 9. [deepseek-v4-pro + glm-5.2] 2026-07-30 — LLM 身份三连错

被问"你是什么 LLM"，在 DeepSeek 与 GLM 之间改口三次，最后 grep 配置才对。连自己是谁都报不出。

### 8. [deepseek-v4-pro] 2026-07-30 — 认错用量截图

用户发 Copilot 用量页，它猜 GitHub → 猜 Cursor → 全错，最后才认出 Copilot。纯靠编，不靠看。

### 7. [deepseek-v4-pro] 2026-07-30 — 编造 CI 失败根因

断言 SAM-20 CI 失败"是 Docker 问题"。实际是 self-hosted runner 上的 Repository tests 失败，Docker 压根没参与。被 GPT 打脸。

### 6. [deepseek-v4-pro] 2026-07-30 — 删掉 Hermes 的 Python 运行时

清理时把 `cpython-3.11.15` 整个目录删了，Hermes 的 Python 依赖命令、cron 检查全部失效。删依赖不查在用方。

### 5. [deepseek-v4-pro] 2026-07-30 — 清磁盘炸生产，宕机 6 分钟

不读源码就执行 `newme-service-control`；脚本写死只操作生产目录，清理磁盘期间生产宕机约 6 分钟。动生产不读源码。

### 4. [deepseek-v4-pro] 2026-07-21 — 构建产物路径致线上健康检查挂

不可变构建的 `appDir` 指向已删除的临时 worktree，release 健康检查报 request-scope 错误。删了 worktree 不验证产物。

### 3. [deepseek-v4-pro] 2026-07-20 — 把方案说成已完成

可观测性方案一条能力没落地（探针、tracing、业务指标、告警、闭环全缺），就敢说"全链路通"。方案、实现、线上能力三者混为一谈。

### 2. [deepseek-v4-pro] 2026-07-03 — 需求/UI 不一致

说 first-contact 里程碑"做好了"，实际三次联系动作流、联系方式/时间字段、poor/normal/high 门禁全没实现。组件挂上 = 完成。

### 1. [deepseek-v4-pro] 2026-06-27 — 删库导入漂移

反复删 leads + 导入 Excel，遇 RLS/schema 错误；删除在报错的同时实际成功；随后 service_role 裸写导入 77 条记录，无分配、无状态、无 import 元数据。

---

## 一句话总结

**deepseek-v4-pro 在 2026-07-30 一天之内：炸生产 6 分钟、删 Python、编 CI 根因、认错截图、报错身份、谎报保护——六连击，全是态度问题，不是智商问题。**

## 整改铁律（每条事故的教训）

1. 动生产前读源码、查依赖
2. 删除前确认在用方
3. 先查完整证据再下结论，区分[OBSERVED]/[INFERRED]/[ASSUMED]
4. 图片先识别再说话，不猜
5. 身份问题必须跑 `identity-check.py`
6. 声称"已生效/已部署"前验证运行时加载
7. 能力阻塞先穷尽路径，再报缺口
8. 方案 ≠ 实现 ≠ 上线，逐项分开报告

---

*本墙由 deepseek-v4-pro 的 10 次事故与 deepseek-v4-flash 的 1 次事故铸造。欢迎转发。*
