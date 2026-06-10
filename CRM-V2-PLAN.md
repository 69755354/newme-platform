# NewMe CRM v2 重建方案

## 品牌调性（从 newme.ae 提取）
- 暗底色: #1E2328（网页hero区），暖奶油: #F5F0EC
- 铜色强调: #D4A373（正向操作），品牌红: #E5007E（警示/CTA）
- 暖墨色: #2C2420（浅底文字）
- 设计原则: 奢侈、克制、信息密度高、无视觉噪音

## 参考标杆
- HubSpot: 漏斗可视化 + 客户时间线
- Pipedrive: Kanban pipeline + 老板一眼看全局
- Monday: 项目阶段管理
- Linear: 极简界面，信息密度

## 页面结构（4页）

### 1. 驾驶舱 Dashboard (`/dashboard`)
**目标: 老板30秒了解公司状况**

顶部4卡片:
- 本月签约金额 (AED) + 环比
- 本月回款金额 (AED) + 环比  
- 在建项目数
- 待收款金额

中部: 5阶段销售漏斗（Tanya的原始定义）
```
线索池(有效) → 意向线索 → 等待方案 → 已拒绝 → 成交
   N             N×X%       N×Y%      N×Z%    N×W%
```
每个阶段显示: 数量 + 阶段转化率 + 金额

底部: 
- 近4周新增趋势线
- 渠道来源分布（Meta Ads / Instagram / Referral / Other）
- 项目风险预警（超期/超预算）

### 2. 线索看板 Leads (`/leads`)  
**Kanban视图（Pipedrive风格）**

5列对应漏斗阶段，每列:
- 阶段名称 + 数量 + 金额合计
- 卡片: 客户名 + 位置 + 项目类型 + 金额 + 负责人头像 + 上次跟进天数

顶部工具栏:
- 搜索
- 筛选: 阶段/来源/负责人/质量/时间范围
- 排序: 优先级/金额/时间
- 批量操作按钮

### 3. 客户详情 (`/leads/[id]`)
**时间轴为核心（Linear风格）**

左侧: 客户信息卡片
- 姓名/电话/位置/房型/面积
- 预算/系统类型
- 负责人
- 当前阶段

右侧主区域: 时间轴
```
2026-05-01  线索进入 (Meta Ads, Dubai Hills)
2026-05-03  首次联系，确认需求（3房别墅，KNX全屋）
2026-05-08  方案提交（AED 85,000）
2026-05-12  报价确认
2026-05-15  签约 → 收首款30%
2026-05-20  开工
2026-06-01  调试完成
2026-06-05  验收 → 收尾款
```

底部tab: 报价单 / 合同 / 图纸 / 现场照片 / 付款记录

### 4. 项目中心 `/projects`
**Monday风格**

卡片视图，每项目卡片:
- 项目名/客户/地址
- 当前阶段进度条（设计→采购→安装→调试→验收）
- 负责人 + 开始/预计完成时间
- 风险标记

## 颜色方案

```css
:root {
  --bg-primary: #1E2328;
  --bg-card: rgba(245, 240, 236, 0.04);
  --bg-card-hover: rgba(245, 240, 236, 0.08);
  --text-primary: #EAE6DF;
  --text-secondary: rgba(234, 230, 223, 0.6);
  --accent-copper: #D4A373;
  --accent-red: #E5007E;
  --accent-green: #4ADE80;
  --accent-amber: #FBBF24;
  --border: rgba(234, 230, 223, 0.1);
}
```

## 数据修复
1. TRUNCATE leads（已完成）
2. 从Google Sheets重新导入271条，正确mapping:
   - Status "Fake Leads" / quality "0%" → disqualified_candidate=true
   - Status "Rejection" → funnel_stage="lost"
   - Status "Good Leads" + quality high → funnel_stage="contacted"
   - Status "Quoted"/"Waiting for quote" → funnel_stage="quotation_submitted"
   - 默认 → funnel_stage="new"
3. 正确保留原始created_at时间戳（非迁移时间）

## 5阶段漏斗映射（对齐Tanya）
| Tanya阶段 | 中文 | funnel_stage |
|-----------|------|-------------|
| 线索池(总有效) | 新线索 | new |
| 意向线索 | 已联系 | contacted |
| 等待方案阶段 | 报价/方案 | quotation_submitted |
| 已拒绝 | 已流失 | lost |
| 成交阶段 | 已成交 | won |

## 执行顺序
1. 数据迁移（正确导入271条）
2. Dashboard重写（新品牌色 + 5阶段漏斗 + 趋势）
3. Leads kanban视图
4. 客户详情页（时间轴）
5. 项目中心
6. 构建部署验证
