# WhatsApp 线索 AI 需求摘要（默认关闭）

目标：WhatsApp 线索第一轮对话结束后，销售在打电话前能在线索详情页看到一张只读小卡片：需求摘要（房型、区域、范围、预算、时间、语言）加“建议线索质量”（好/一般/差 + 一句理由）。
摘要由定时的 Claude 会话生成（服务器上没有 LLM 密钥）。系统只提供“导出”和“写入”两段管道。

## 安全边界

- 只写 `activities` 一条备注（`metadata.source = ai_note`，标题“AI 摘要（自动，仅供参考）”）。
- 绝不改 `leads.quality`、阶段、负责人，不发任何东西给 Meta。建议质量只存在备注里，销售自己决定是否采用。
- 同一条线索 + 同一个“最新消息时间”（watermark）只写一次，重复提交返回 `duplicate`。

## 开启所需环境变量（运行环境，不要进 git / 聊天 / 日志）

| 变量 | 说明 |
| --- | --- |
| `AI_NOTES_ENABLED=true` | 总开关，默认 `false`，关闭时接口返回 503 |
| `AI_NOTES_TOKEN` | 至少 32 个字符的随机串；例程用 `Authorization: Bearer ...` 调用 |

导出脚本需要应用已有的 `NEXT_PUBLIC_SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`（只读，脚本只发 GET）。

## 1. 导出队列（只读）

```
node scripts/wa-ai-queue.mjs
```

每行一个 JSON：`{lead_ref, lead_id, watermark, messages:[{dir:"in"|"out", text, at}]}`，最近 30 条、只含文字、不含电话号码。入选条件：
对话里客户来信至少 2 条、安静至少 30 分钟、线索创建在 14 天内且未归档、没有已覆盖最新消息的 AI 备注。

## 2. 例程提示词（定时 Claude 会话每次执行）

```
你是 NewMe 的线索助理。依次执行：
1. 运行 `node scripts/wa-ai-queue.mjs`，读取每一行 JSON（没有输出就结束，什么都不做）。
2. 对每条线索，只根据 messages 里的内容（dir=in 是客户，out 是我们），写一个简短摘要，中文在前，英文一句在后，
   合计不超过 500 字符，涵盖：房型、区域/位置、装修范围、预算、时间要求、客户使用的语言。没提到的写“未提及”，不要猜测。
3. 判断建议线索质量 suggested_quality：good（需求、预算或时间明确，积极回应）/ normal（信息不全但有意向）/
   poor（明显无意向、信息矛盾、纯询价或垃圾信息）；reason 用一句中文说明理由（不超过 150 字符）。
4. 把结果分批（每批最多 50 条）POST 到本机应用：
   POST $APP_URL/api/leads/ai-notes
   Authorization: Bearer $AI_NOTES_TOKEN
   {"items":[{"lead_id":"...","watermark":"（原样带回导出的 watermark）","summary":"...","suggested_quality":"good|normal|poor","reason":"..."}]}
5. 汇报 counts（created / duplicate / not_found / invalid / failed）。不要修改任何其他数据，不要联系客户，不要把客户文字写进日志或 git。
```

建议每 30 分钟运行一次；没有新增线索时导出为空，例程立即结束。

## 3. 回退

把 `AI_NOTES_ENABLED` 改回 `false`（或删除）即可停用写入；已写的备注是普通时间线备注，不影响线索数据。
