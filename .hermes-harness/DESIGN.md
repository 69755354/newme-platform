# NewMe Harness — Agent Infrastructure Design

## 现状

```
用户说需求 → Agent 读 TASKBOARD + SPEC → 试 → 失败 → 再试 → 再失败 → 
 compaction → 丢失上下文 → 从头来 → 用户怒了
```

核心问题：**每次任务都是从零开始的理解过程，没有积累。**

TASKBOARD.md 只管"做完没"，不管"怎么做的、为什么失败、学到了什么"。
Subagent 互相隔离，Agent A 踩的坑 Agent B 再踩一遍。
Compaction 后上下文丢失，经验清零。

## MopMonk 给我们的启发

不是模型的问题（都用 MiniMax M3），是 Harness 的问题：

| | MopMonk | 我们 |
|---|---|---|
| 记忆 | 结构化、可更新 | 线性聊天、compaction 丢失 |
| 探索 | 每次基于已有证据收敛 | 每次从零试错 |
| 协作 | 共享记忆、继承失败经验 | Subagent 完全隔离 |
| 领域知识 | 专门为漏洞挖掘设计 | 通用 Agent 无领域适配 |

## 设计方案

### 核心原则

1. **一份真相源** — 不是又一个文件，是 TASKBOARD 的增强版
2. **机器可读写** — Agent 自己写、自己读，不需要人维护
3. **压缩友好** — Compaction 后核心信息不丢失
4. **渐进式** — Phase 1 只做 bug fix harness，验证有效再扩展

### Phase 1: Bug Fix Harness（最小可行）

只解决一个场景：**修 bug**。这是最痛的——agent 反复试、反复失败、context 爆炸。

```
newme-platform/
├── .hermes-harness/
│   ├── memory/
│   │   ├── task-001.json    ← 每个任务一个文件
│   │   └── task-002.json
│   ├── codebase/
│   │   └── index.json       ← 代码库结构索引
│   └── lessons.json          ← 跨任务经验
```

#### task-NNN.json 结构

```json
{
  "task_id": "TASK-001",
  "source": "TASKBOARD.md line 42",
  "title": "线索页首屏无横向滚动条",
  "status": "in_progress",
  "attempts": [
    {
      "id": 1,
      "agent": "hermes-main",
      "hypothesis": "overflow-x: auto 没加到正确的容器上",
      "files_touched": ["app/leads/page.tsx", "components/LeadTable.tsx"],
      "result": "failed",
      "evidence": "加了 overflow-x: auto 到 .table-container，但 table 本身宽度由内容决定，没有 min-width",
      "error_output": "滚动条仍不出现",
      "timestamp": "2026-07-03T12:00:00Z"
    },
    {
      "id": 2,
      "agent": "subagent-abc",
      "hypothesis": "table 需要设置 min-width 才能触发容器 overflow",
      "files_touched": ["components/LeadTable.tsx"],
      "result": "partial",
      "evidence": "min-width: 800px 后首屏出现滚动条，但向下滚动时页面整体仍锁死",
      "error_output": "",
      "timestamp": "2026-07-03T12:15:00Z"
    }
  ],
  "resolved_knowledge": {
    "root_cause": "",
    "fix": "",
    "affected_components": [],
    "test_to_verify": ""
  }
}
```

#### Agent 工作流

```
1. Agent 收到任务
2. 读 TASKBOARD.md — 知道要做什么
3. 读 .hermes-harness/memory/task-NNN.json — 知道别人试过什么、为什么失败
4. 基于已有证据提出新假设（不是从零开始）
5. 执行 → 无论成功失败，写回 memory
6. 如果成功 → 更新 resolved_knowledge
```

#### Subagent 共享

```
主 Agent 派 Subagent A:
  → 读 task-NNN.json（继承所有历史尝试）
  → 提出假设，执行
  → 写回 task-NNN.json（贡献新证据）

主 Agent 派 Subagent B:
  → 读 task-NNN.json（看到 A 刚写的失败记录）
  → 避开 A 走过的死路
  → 写回
```

### Phase 2: 扩展到全流程（验证后）

- Feature 开发 harness
- 部署 harness
- 代码审查 harness

## 和现有系统的关系

**不是替代，是增强：**

| 现有 | Harness 增强 |
|------|-------------|
| TASKBOARD.md | task-NNN.json = TASKBOARD 的"过程记录" |
| SPEC.md | codebase/index.json = SPEC 的"可查询版" |
| agent.log | memory/ = 结构化的、可继承的经验 |
| Subagent | 共享 memory/ 而非隔离 |

## 实施计划

### 第一步：建 Schema + 种子数据（今天）

1. 创建 `.hermes-harness/` 目录结构
2. 从 TASKBOARD.md 的 ❌ 项生成初始 task-NNN.json
3. 从项目文件树生成 codebase/index.json

### 第二步：写 Agent 指令（今天）

4. 创建 Skill: `bug-fix-harness` — Agent 如何读/写 memory
5. 修改 Subagent delegation 指令 — 共享 memory 路径

### 第三步：实战验证（选一个 bug）

6. 拿一个已知的反复失败的 bug（如线索页滚动条）
7. 用 harness 流程走一遍
8. 对比：有 harness vs 无 harness 的 token 消耗、成功率、轮次

## 为什么这个设计能解决我们的问题

1. **不再从零开始** — Agent 开任务前先读 memory，知道前人踩过什么坑
2. **Subagent 不再重复劳动** — 共享 memory，A 的失败 B 不会重蹈
3. **Compaction 安全** — task-NNN.json 是文件不是上下文，compact 后还在
4. **渐进式** — Phase 1 只做 bug fix，不改现有工作流，验证有效再扩
5. **可度量** — attempt 次数、收敛速度、token 消耗，全可对比
