#!/usr/bin/env python3
"""generate-schema-tables.py — Extract table/column/type/comment from Supabase migrations.

Writes Markdown schema documentation to /tmp/p1-schema-doc.md.
Also writes plain table list to scripts/schema-tables.txt (original behavior preserved).
"""

import re
import glob
import os
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = PROJECT_DIR / "supabase" / "migrations"
OUTPUT_FILE = PROJECT_DIR / "scripts" / "schema-tables.txt"
MD_OUTPUT = Path("/tmp/p1-schema-doc.md")


# ── Column name → business comment inference ──────────────────────────────────

COLUMN_COMMENTS: dict[str, str] = {
    # Generic
    "id": "主键",
    "created_at": "创建时间",
    "updated_at": "更新时间",
    "tenant_id": "租户ID",
    "notes": "备注",
    "metadata": "扩展元数据(JSON)",
    "details": "详情(JSON)",
    "ip_address": "IP地址",
    "user_agent": "浏览器标识",
    "session_id": "会话标识",

    # User / Profile
    "user_id": "用户ID",
    "actor_id": "操作者ID",
    "actor_email": "操作者邮箱",
    "full_name": "姓名",
    "email": "邮箱",
    "phone": "电话",
    "role": "角色",
    "manager_id": "直属上级ID",
    "is_active": "是否在职",
    "last_active_at": "最后活跃时间",
    "joined_at": "入职日期",
    "assigned_to": "指派给(用户ID)",
    "created_by": "创建人ID",
    "set_by": "设定人ID",
    "confirmed_by": "确认人ID",
    "sales_id": "销售ID",
    "assigned_sales_id": "指派销售ID",
    "project_manager": "项目经理ID",

    # Lead
    "lead_id": "线索ID",
    "customer_id": "客户ID",
    "customer_name": "客户名称",
    "stage": "阶段",
    "lead_status": "线索状态(hot/warm/cold/dormant)",
    "last_contact_date": "最近联系日期",
    "disqualified_candidate": "是否不合格线索",
    "won_at": "赢单时间",
    "archived_at": "归档时间",

    # Product / Quotation
    "sku": "SKU编码",
    "name": "名称",
    "description": "描述",
    "category": "分类",
    "brand": "品牌",
    "unit": "单位",
    "unit_price": "单价",
    "quote_no": "报价单号",
    "version": "版本号",
    "subtotal": "小计",
    "discount_rate": "折扣率(%)",
    "discount_amount": "折扣金额",
    "tax_rate": "税率(%)",
    "tax_amount": "税额",
    "total_amount": "总金额",
    "currency": "币种",
    "valid_until": "有效期至",
    "payment_terms": "付款条款",
    "delivery_terms": "交货条款",
    "status": "状态",
    "pdf_url": "PDF文件地址",
    "ppt_url": "PPT文件地址",
    "devices_json": "设备清单(JSON)",
    "internal_notes": "内部备注",

    # Contract
    "contract_id": "合同ID",
    "contract_no": "合同编号",
    "contract_date": "合同日期",
    "contract_amount": "合同金额",
    "party_a_name": "甲方名称",
    "party_a_contact": "甲方联系人",
    "party_b_name": "乙方名称",
    "party_b_contact": "乙方联系人",
    "file_url": "合同文件地址",
    "file_metadata": "合同文件元数据",
    "approval_status": "审批状态",
    "terminated_reason": "终止原因",
    "terminated_at": "终止时间",

    # Installment
    "seq": "分期序号",
    "amount": "金额",
    "due_date": "到期日",
    "paid_amount": "已付金额",

    # Payment
    "installment_plan_id": "分期计划ID",
    "payment_date": "付款日期",
    "received_at": "到账时间",
    "payment_method": "付款方式",
    "reference_no": "参考号/交易号",
    "confirmed": "是否已确认",
    "confirmed_at": "确认时间",
    "overpayment_action": "超额处理方式",

    # Activity
    "action": "操作类型",
    "entity_type": "实体类型(lead/quotation/contract/...)",
    "entity_id": "实体ID",
    "type": "活动类型(call/meeting/...)",
    "duration": "时长(秒)",
    "is_completed": "是否已完成",
    "due_at": "截止时间",
    "priority": "优先级",
    "quotation_id": "报价单ID",
    "duration_seconds": "时长(秒)",
    "pages_viewed": "浏览页面数",
    "actions_count": "操作次数",
    "login_count": "登录次数",
    "total_duration_seconds": "总在线时长(秒)",
    "first_login": "首次登录时间",
    "last_active": "最后活跃时间",
    "session_date": "会话日期",
    "page_path": "页面路径",

    # Events / Audit
    "event_type": "事件类型",
    "target_type": "目标类型",
    "target_id": "目标ID",

    # KPI
    "period": "期间(如2026-06)",
    "target_type": "目标类型(signing/collection)",
    "target_amount": "目标金额",

    # Pipeline
    "quotation_value": "报价金额",
    "probability": "成交概率",

    # Projects
    "phase": "项目阶段",

    # CRM v3
    "milestone": "里程碑",
    "next_action": "下一步行动",
    "next_action_date": "下一步行动日期",
    "no_answer": "无人接听标记",
    "first_contact_time": "首次联系时间",
    "contact_time": "联系时间",

    # Ad spend
    "platform": "广告平台",
    "spend": "花费",
    "impressions": "曝光量",
    "clicks": "点击量",
    "leads_generated": "产生线索数",
    "spend_date": "投放日期",

    # Notifications
    "title": "标题",
    "message": "消息内容",
    "notification_type": "通知类型",
    "read": "是否已读",
    "read_at": "阅读时间",

    # Tags
    "tags": "标签数组",
}

TABLE_COMMENTS: dict[str, str] = {
    "profiles": "用户/员工档案",
    "leads": "销售线索",
    "customers": "客户",
    "activities": "销售活动记录",
    "business_events": "业务事件日志",
    "projects": "项目",
    "products": "产品",
    "quotations": "报价单",
    "contracts": "合同",
    "installment_plans": "分期付款计划",
    "payments": "收款记录",
    "activity_logs": "用户操作日志",
    "user_session_daily": "用户每日会话汇总",
    "audit_logs": "管理员审计日志",
    "kpi_targets": "KPI目标",
    "ad_spend": "广告投放记录",
    "notifications": "系统通知",
    "pipeline_stages": "销售漏斗阶段配置",
    "stage_to_milestone": "阶段→里程碑映射",
    "lead_alerts": "线索预警",
    "follow_up_logs": "跟进日志",
    "workflow_stages": "工作流阶段",
    "crm_v3_import_archive": "CRM v3导入归档",
    "contract_pipeline": "合同管道",
    "products_leads": "产品-线索关联",
    "lead_round_robin": "线索轮转分配",
}


# ── Core extraction logic (preserved from original) ───────────────────────────

def _infer_comment(col_name: str, col_type: str, sql_comment: str | None) -> str:
    """Infer a business comment from SQL inline comment, known map, or column name."""
    if sql_comment:
        return sql_comment.strip()

    # Check known comments map
    if col_name in COLUMN_COMMENTS:
        return COLUMN_COMMENTS[col_name]

    # Heuristic: split on underscore and translate common suffixes
    parts = col_name.split("_")
    if parts[-1] == "id" and len(parts) > 1:
        return f"{'_'.join(parts[:-1])} ID"
    if parts[-1] == "at" and len(parts) > 1:
        return f"{'_'.join(parts[:-1])} 时间"
    if parts[-1] == "by" and len(parts) > 1:
        return f"{'_'.join(parts[:-1])} 人"
    if parts[-1] == "url":
        return f"{'_'.join(parts[:-1])} 地址"

    return ""


def _clean_type(raw_type: str) -> str:
    """Clean up the SQL type string for display."""
    t = raw_type.strip()
    # Remove CHECK with nested parens
    t = _remove_check_constraint(t)
    # Remove NOT NULL, DEFAULT ...
    t = re.sub(r"\s+NOT\s+NULL", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+DEFAULT\s+.+?(?=(,|$|\s+CHECK|\s+REFERENCES|\s+UNIQUE|\s+PRIMARY))", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+PRIMARY\s+KEY", " PK", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+UNIQUE", " UNIQUE", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+CHECK\s*\([^)]+\)", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+REFERENCES\s+\S+", " FK", t, flags=re.IGNORECASE)
    t = re.sub(r"\s{2,}", " ", t)
    # Strip trailing commas left by constraint removal
    t = t.rstrip(" ,")
    return t.strip()


def _remove_check_constraint(text: str) -> str:
    """Remove CHECK(...) including nested parens from a type string."""
    # Match CHECK followed by balanced parens
    result = []
    i = 0
    while i < len(text):
        m = re.match(r"\s+CHECK\s*\(", text[i:], re.IGNORECASE)
        if not m:
            result.append(text[i])
            i += 1
            continue
        # Append whitespace before CHECK
        # Find the balanced closing paren
        start = i + m.end() - 1  # position of opening (
        depth = 1
        j = start + 1
        while j < len(text) and depth > 0:
            if text[j] == "(":
                depth += 1
            elif text[j] == ")":
                depth -= 1
            j += 1
        i = j  # skip past the closing )
        # result doesn't include the CHECK(...)
    return "".join(result)


def extract_schema() -> list[dict]:
    """Extract tables, columns, types, and comments from all migration SQL files."""
    tables: list[dict] = []
    seen_tables: set[str] = set()

    sql_files = sorted(glob.glob(str(MIGRATIONS_DIR / "*.sql")))

    for fpath in sql_files:
        with open(fpath, encoding="utf-8", errors="replace") as fh:
            content = fh.read()

        # Find CREATE TABLE blocks — capture table name and body
        pattern = re.compile(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\((.*?)\)\s*;",
            re.IGNORECASE | re.DOTALL,
        )

        for m in pattern.finditer(content):
            table_name = m.group(1)
            if table_name.upper() == "AS":
                continue
            if table_name in seen_tables:
                continue
            seen_tables.add(table_name)

            body = m.group(2)

            # Extract table-level comment
            table_comment = TABLE_COMMENTS.get(table_name, "")
            before_match = content[: m.start()]
            header_lines = before_match.strip().split("\n")
            for line in reversed(header_lines[-5:]):
                line = line.strip()
                if line.startswith("--") and not line.startswith("-- ="):
                    comment = line.lstrip("- ").strip()
                    if comment and len(comment) > 3 and "table" in comment.lower():
                        if not table_comment:
                            table_comment = comment
                        break

            # Extract inline comments from raw body first (before stripping)
            raw_lines = body.split("\n")
            inline_comments: dict[str, str] = {}  # col_name_prefix -> comment
            for line in raw_lines:
                comment_pos = line.find("--")
                if comment_pos < 0:
                    continue
                comment_text = line[comment_pos + 2:].strip()
                before_comment = line[:comment_pos].strip().rstrip(",")
                col_name_match = re.match(r"(\w+)", before_comment)
                if col_name_match:
                    inline_comments[col_name_match.group(1)] = comment_text

            # Parse columns from cleaned body
            columns: list[dict] = []
            col_defs = _split_column_defs(body)

            for col_def in col_defs:
                col_def = col_def.strip()
                if not col_def:
                    continue
                # Skip constraint lines
                if re.match(
                    r"^\s*(?:UNIQUE|PRIMARY|FOREIGN|CONSTRAINT|CHECK)\b",
                    col_def,
                    re.IGNORECASE,
                ):
                    continue

                # Split: column_name type [constraints...]
                parts = col_def.split(None, 1)
                if len(parts) < 2:
                    continue
                col_name = parts[0].strip()
                if col_name.upper() in (
                    "UNIQUE", "PRIMARY", "FOREIGN", "CONSTRAINT", "CHECK",
                ):
                    continue
                raw_type = parts[1].strip()

                clean_type = _clean_type(raw_type)

                # Use inline comment from raw body, fall back to inference
                comment = inline_comments.get(col_name) or ""
                if not comment:
                    comment = _infer_comment(col_name, clean_type, None)

                columns.append({
                    "name": col_name,
                    "type": clean_type,
                    "comment": comment,
                })

            if columns:
                tables.append({
                    "name": table_name,
                    "comment": table_comment,
                    "columns": columns,
                })

    return tables


def _split_column_defs(body: str) -> list[str]:
    """Split CREATE TABLE body into column definitions.

    Preprocess: strip -- inline comments then split by comma at depth 0.
    """
    # Strip -- style comments (from -- to end of line)
    lines = body.split("\n")
    cleaned_lines = []
    for line in lines:
        # Find -- not inside a string literal
        comment_pos = line.find("--")
        if comment_pos >= 0:
            line = line[:comment_pos]
        cleaned_lines.append(line)
    cleaned = "\n".join(cleaned_lines)

    # Now split by comma at depth 0 (no comments to worry about)
    result: list[str] = []
    depth = 0
    current: list[str] = []
    for ch in cleaned:
        if ch == "(":
            depth += 1
            current.append(ch)
        elif ch == ")":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            result.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        remainder = "".join(current).strip()
        if remainder:
            result.append(remainder)

    return result


# ── Table-name-only output (original behavior) ────────────────────────────────

def write_table_list(tables: list[dict]):
    table_names = sorted(t["name"] for t in tables)
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w") as fh:
        for name in table_names:
            fh.write(name + "\n")
    print(f"Extracted {len(table_names)} tables → {OUTPUT_FILE}")


# ── Markdown output ───────────────────────────────────────────────────────────

def write_markdown(tables: list[dict]):
    lines: list[str] = []
    lines.append("<!-- auto-generated by scripts/generate-schema-tables.py -->")
    lines.append("")
    lines.append("# Supabase Schema Reference")
    lines.append("")
    lines.append(f"**Tables extracted:** {len(tables)}")
    lines.append("")
    lines.append("---")
    lines.append("")

    for t in sorted(tables, key=lambda x: x["name"]):
        table_name = t["name"]
        table_comment = t.get("comment", "")
        cols = t["columns"]

        lines.append(f"## `{table_name}`")
        if table_comment:
            lines.append(f"")
            lines.append(f"> {table_comment}")
        lines.append("")
        lines.append("| 列名 | 数据类型 | 业务注释 |")
        lines.append("|------|---------|---------|")

        for col in cols:
            cname = col["name"]
            ctype = col["type"]
            ccomment = col.get("comment", "")
            lines.append(f"| `{cname}` | `{ctype}` | {ccomment} |")

        lines.append("")
        lines.append("---")
        lines.append("")

    MD_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    MD_OUTPUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"Schema docs written → {MD_OUTPUT}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    tables = extract_schema()

    # Original behavior
    write_table_list(tables)

    # Enhanced: Markdown output
    write_markdown(tables)


if __name__ == "__main__":
    main()
