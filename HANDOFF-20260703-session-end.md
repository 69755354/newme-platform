# HANDOFF — 2026-07-03 Session End

## 1. 当前状态
- 项目: NewMe CRM (Next.js 16, /home/ubuntu/newme-platform)
- 分支: main, HEAD=4b76308
- TASKBOARD: 18 PASS / 0 FAIL
- 唯一 ❌ = **T3-1: DashboardLayout unification**
- 审计链已更新: OpenCode (GLM-5.2 编码) → Codex (GPT-5.5 一审) → Hermes (Qwen3.7-max 终审)
- CC (Claude Code) 已淘汰 (K7I7-BA key 过期 2026-07-03)

## 2. 完整推理链

### 触发
CC (Claude Code) 的 K7I7-BA key 于 2026-07-03 过期。需要迁移到 OpenCode + GLM-5.2 CP 作为编码主力。

### 分析
- OpenCode v1.17.9 已安装，GLM-5.2 CP 配置就绪 (`~/.config/opencode/opencode.json`)
- Codex v0.142.0 OAuth 已恢复
- 所有 skill 文件中 CC 引用需要替换/标记废弃

### 决策
分两阶段:
- **P1**: Memory 更新 (CC 淘汰记录) → 已完成
- **P2**: Skill 文件 CC 引用清零 → 已完成

### 否决
- 不修改历史 reference 文件 (claude-code-token-tracking.md, claude-code-glm-cp-direct.md) — 归档性质
- 不修改历史事件描述中的 CC 引用 — 那些是真实发生的事件

## 3. 已完成

### P1: Memory 更新
| 文件 | 变更 | 验证 |
|------|------|------|
| USER.md | CC→OpenCode 审计链记录 | memory tool 输出确认 |
| MEMORY.md | CC 淘汰 + OpenCode 替代 | memory tool 输出确认 |

### P2: Skill 文件 CC 引用清零
| 文件 | 变更 | 验证 |
|------|------|------|
| task-lifecycle-protocol/SKILL.md | 33处 CC→OpenCode (保留3处历史事件) | grep: 3 remaining (历史) |
| anti-hallucination-system/SKILL.md | 10处 CC→OpenCode | grep: 0 remaining |
| v4-to-glm52-coding-handoff/SKILL.md | description + 架构段更新 (297处历史引用保留) | grep: 297 remaining (历史) |
| codex-integration/SKILL.md | 审计角色补充 | grep: 0 remaining |
| hermes-model-bridge/SKILL.md | 17处替换/废弃标记 | grep: 8 remaining (deprecated section) |
| runtime-architecture-decisions/SKILL.md | description 更新 | grep: 0 remaining |
| cc-bridge.md | 已删除 | file not found |

### T3-1: DashboardLayout unification (进行中)
- **背景**: DashboardScrollContainer 组件已存在，但仅 3/24 页面采用
- **任务**: 将剩余 21 个页面根 div 包裹 `<DashboardScrollContainer>`
- **执行**: 已派 delegate_task 子代理处理 19 个页面
- **结果**: 子代理返回"部分成功" — 19 页面处理中部分 import 添加成功但包裹替换不完整
- **验证**: tsc 0 errors, build 环境依赖缺失未验证

## 4. 待执行

### T3-1 收尾 (唯一 ❌)
```
文件: 21 个 dashboard page.tsx 文件
任务: 每个页面:
  1. 添加 import { DashboardScrollContainer } from "@/components/DashboardScrollContainer"
  2. 根 div 替换为 <DashboardScrollContainer className="原className">
  3. 对应 </div> 替换为 </DashboardScrollContainer>
验证:
  - npx tsc --noEmit (期望 0 errors)
  - NEXT_NO_TURBOPACK=1 npx next build --dist-dir=.next-test-$RANDOM
  - bash scripts/check-taskboard.sh (期望 18 PASS 不下降)
  - grep -rn 'DashboardScrollContainer' src/app/'(dashboard)'/*/page.tsx 应返回 24 个文件
当前状态: 子代理部分完成，需逐文件检查并补完
```

### claude-code.md
```
文件: ~/.hermes/skills/claude-code.md
状态: 文件不存在
决策: 新 session 判断是否需要创建 opencode-glmcoding.md 替代，或直接跳过
```

### 生产验证 (T3-1 完成后)
```
1. git add + commit + push (message 含 [GLM-CP] 标记)
2. 部署到生产
3. 浏览器验证所有 dashboard 页面滚动行为正常
```

## 5. 死路

### 死路1: opencode run 直接调用
```
命令: opencode run "$(cat prompt.md)" --max-turns 30
错误: Unknown arguments: max-turns / 参数解析失败
原因: OpenCode CLI 参数格式不同于 CC
正确用法: 
  - delegate_task → 通过 Hermes ACP 层调用 OpenCode agent ✅
  - opencode (TUI, pty=true, background) → 交互模式
```

### 死路2: Hermes 直接 patch 文件
```
用户强烈反对: "你直接改，那今天弄了一晚上的生产工具白费了？"
规则: 编码任务必须走 OpenCode → Codex → Hermes 审计链
禁止: Hermes 自己用 patch/write_file 改源代码
```

### 死路3: build 验证
```
命令: npx next build
错误: 环境依赖缺失 (node_modules 不完整)
解决: npm install 后再 build，或用 --dist-dir 隔离测试
注意: 绝对不在生产目录跑裸 build — 会覆盖 .next/ 导致线上 5xx
```

## 6. 关键文件

| 路径 | 用途 |
|------|------|
| /home/ubuntu/newme-platform/TASKBOARD.md | 任务追踪真相源 |
| /home/ubuntu/newme-platform/scripts/check-taskboard.sh | 部署门禁 |
| src/components/DashboardScrollContainer.tsx | T3-1 核心组件 |
| src/shared/hooks/useDashboardScroll.ts | T3-1 hook 版本 |
| src/app/(dashboard)/layout.tsx | Dashboard 滚动边界 |
| ~/.config/opencode/opencode.json | OpenCode GLM-5.2 配置 |
| ~/.codex/config.toml + auth.json + AGENTS.md | Codex 审计配置 |
| ~/.hermes/skills/opencode/SKILL.md | OpenCode 使用指南 |
| ~/.hermes/skills/v4-to-glm52-coding-handoff/SKILL.md | 编码闸门 |
| ~/.hermes/skills/handoff-protocol/SKILL.md | 交接协议 |

## 7. 用户偏好提醒
- 禁止收工/去睡/疲劳推测
- "需要" = 立刻执行
- 编码走审计链，Hermes 不直接改源码
- 中文短回复 + 已验证
- 不替用户决定收工时机
- >3分钟无输出 = 掉线
- commit message 含 [GLM-CP]
