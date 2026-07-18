#!/usr/bin/env python3
"""Versioned NewMe CRM regression harness.

Live usage:
  python3 scripts/crm-regression.py --pre-deploy
  python3 scripts/crm-regression.py --post-deploy

CI contract usage:
  python3 scripts/crm-regression.py --self-test
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SALES_CAPABLE_ROLES = {"sales", "operator", "boss"}


def eligible_reassignment_profiles(profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return only active profiles that can own sales cases."""
    return [
        profile
        for profile in profiles
        if profile.get("is_active") is True
        and profile.get("role") in SALES_CAPABLE_ROLES
    ]


def historical_owner_name(
    lead: dict[str, Any], profiles_by_id: dict[str, dict[str, Any]]
) -> str | None:
    """Resolve identity from every profile, including inactive former employees."""
    owner_id = lead.get("assigned_to")
    if not owner_id:
        return None
    owner = profiles_by_id.get(owner_id)
    if not owner:
        return None
    return owner.get("full_name") or owner.get("email") or owner_id


def run_contract_self_test() -> int:
    """Exercise personnel contracts without network or production credentials."""
    profiles = [
        {
            "id": "active-sales",
            "full_name": "Active Sales",
            "role": "sales",
            "is_active": True,
        },
        {
            "id": "active-operator",
            "full_name": "Active Operator",
            "role": "operator",
            "is_active": True,
        },
        {
            "id": "active-boss",
            "full_name": "Active Boss",
            "role": "boss",
            "is_active": True,
        },
        {
            "id": "departed-sales",
            "full_name": "Departed Sales",
            "role": "sales",
            "is_active": False,
        },
        {
            "id": "active-admin",
            "full_name": "Active Admin",
            "role": "admin",
            "is_active": True,
        },
    ]
    leads = [{"id": "historical-case", "assigned_to": "departed-sales"}]

    assert any(profile.get("is_active") is False for profile in profiles)
    candidates = eligible_reassignment_profiles(profiles)
    assert {profile["id"] for profile in candidates} == {
        "active-sales",
        "active-operator",
        "active-boss",
    }

    profiles_by_id = {profile["id"]: profile for profile in profiles}
    assert historical_owner_name(leads[0], profiles_by_id) == "Departed Sales"

    print("contract self-test passed")
    return 0


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.is_file():
        raise RuntimeError(f"environment file not found: {path}")
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if "=" in line and not line.startswith("#"):
            key, _, value = line.partition("=")
            env[key] = value
    return env


class Regression:
    def __init__(
        self,
        *,
        base_url: str,
        supabase_url: str,
        service_key: str,
        result_file: Path,
        verbose: bool,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.supabase_url = supabase_url.rstrip("/")
        self.service_key = service_key
        self.result_file = result_file
        self.verbose = verbose
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []

    def check(self, name: str, condition: bool, detail: str = "") -> bool:
        if condition:
            self.passed += 1
            return True
        self.failed += 1
        self.errors.append(f"失败: {name} — {detail}")
        return False

    def request(self, request: urllib.request.Request, timeout: int = 10) -> Any:
        request.add_header("apikey", self.service_key)
        request.add_header("Authorization", f"Bearer {self.service_key}")
        return urllib.request.urlopen(request, timeout=timeout)

    def http_get(
        self, path: str, expected_statuses: tuple[int, ...] = (200,)
    ) -> tuple[bool, int, str]:
        try:
            request = urllib.request.Request(f"{self.base_url}{path}")
            request.add_header("User-Agent", "CRM-Regression/2.0")
            with urllib.request.urlopen(request, timeout=15) as response:
                body = response.read().decode(errors="replace")[:500]
                return response.status in expected_statuses, response.status, body
        except urllib.error.HTTPError as error:
            return error.code in expected_statuses, error.code, str(error)
        except Exception as error:  # noqa: BLE001 - regression must report all probes
            return False, 0, str(error)

    def db_query(
        self, table: str, select: str = "id", limit: int = 1
    ) -> tuple[bool, Any]:
        try:
            query = urllib.parse.urlencode({"select": select, "limit": str(limit)})
            url = f"{self.supabase_url}/rest/v1/{table}?{query}"
            request = urllib.request.Request(url)
            with self.request(request) as response:
                return True, json.loads(response.read())
        except Exception as error:  # noqa: BLE001 - regression must report all probes
            return False, str(error)

    def db_count(self, table: str) -> tuple[bool, Any]:
        try:
            query = urllib.parse.urlencode({"select": "id", "limit": "1"})
            url = f"{self.supabase_url}/rest/v1/{table}?{query}"
            request = urllib.request.Request(url)
            request.add_header("Prefer", "count=estimated")
            with self.request(request) as response:
                content_range = response.headers.get("content-range", "")
            if "/" in content_range:
                return True, int(content_range.split("/")[-1])
            return True, 0
        except Exception as error:  # noqa: BLE001 - regression must report all probes
            return False, str(error)

    def run(self, mode: str) -> int:
        captured_stdout = None
        if not self.verbose:
            captured_stdout = sys.stdout
            sys.stdout = io.StringIO()

        print(f"CRM 回归测试 — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"模式: {mode}")

        self.run_application_checks()
        profiles = self.run_database_checks()
        self.run_activity_checks()
        self.run_integrity_checks(profiles)
        self.run_source_checks()
        self.write_result()

        if self.failed:
            if captured_stdout is not None:
                sys.stdout = captured_stdout
            total = self.passed + self.failed
            print(f"CRM 回归测试告警 — {self.passed}/{total} 通过, {self.failed} 失败")
            for error in self.errors:
                print(f"  {error}")
            return 1

        if captured_stdout is not None:
            sys.stdout = captured_stdout
        if self.verbose:
            print(f"CRM regression passed: {self.passed} checks")
        return 0

    def run_application_checks(self) -> None:
        ok, status, _ = self.http_get("/api/health")
        self.check("健康检查 API 200", ok, f"返回 {status}")

        ok, status, _ = self.http_get("/login")
        self.check("登录页 200", ok, f"返回 {status}")

        ok, status, _ = self.http_get("/dashboard", (200, 307))
        self.check("看板可达 (200 或 307)", ok, f"返回 {status}")

    def run_database_checks(self) -> list[dict[str, Any]]:
        ok, data = self.db_query("profiles", "id,full_name,email,role,is_active", 1000)
        self.check("profiles 表可访问", ok, str(data)[:100])
        if not ok:
            return []

        profiles: list[dict[str, Any]] = data
        self.check("至少 3 个用户", len(profiles) >= 3, f"实际 {len(profiles)}")
        roles = {profile.get("role") for profile in profiles}
        self.check("含 admin + sales 角色", roles >= {"admin", "sales"}, f"角色={roles}")
        self.check(
            "允许停用人员且启用状态可读取",
            all("is_active" in profile for profile in profiles),
            f"{sum(1 for profile in profiles if not profile.get('is_active'))} 个停用人员",
        )

        candidates = eligible_reassignment_profiles(profiles)
        self.check(
            "转移候选只含启用的 sales/operator/boss",
            all(
                profile.get("is_active") is True
                and profile.get("role") in SALES_CAPABLE_ROLES
                for profile in candidates
            ),
            f"候选数={len(candidates)}",
        )

        ok, count = self.db_count("leads")
        self.check("leads 表可访问", ok and isinstance(count, int), str(count))
        self.check("有线索数据", isinstance(count, int) and count > 0, f"共 {count}")
        return profiles

    def run_activity_checks(self) -> None:
        ok, count = self.db_count("activity_logs")
        self.check("activity_logs 表存在", ok, str(count))

        ok, count = self.db_count("user_session_daily")
        self.check("user_session_daily 表存在", ok, str(count))

        try:
            url = f"{self.supabase_url}/rest/v1/rpc/get_team_activity"
            payload = json.dumps(
                {"p_date": datetime.now().strftime("%Y-%m-%d")}
            ).encode()
            request = urllib.request.Request(url, data=payload, method="POST")
            request.add_header("Content-Type", "application/json")
            with self.request(request):
                pass
            self.check("get_team_activity RPC 可用", True)
        except Exception as error:  # noqa: BLE001 - regression must report all probes
            self.check("get_team_activity RPC 可用", False, str(error))

    def run_integrity_checks(self, profiles: list[dict[str, Any]]) -> None:
        ok, leads = self.db_query(
            "leads", "id,assigned_to,customer_name", 1000
        )
        if ok:
            null_assign = sum(1 for lead in leads if not lead.get("assigned_to"))
            null_name = sum(1 for lead in leads if not lead.get("customer_name"))
            threshold = max(10, len(leads) * 0.2)
            self.check(
                "未分配线索比例正常",
                null_assign <= threshold,
                f"{null_assign} 条未分配 / 共 {len(leads)}",
            )
            self.check("无空名称线索", null_name == 0, f"{null_name} 条空名称")

            profiles_by_id = {profile["id"]: profile for profile in profiles}
            inactive_owned = [
                lead
                for lead in leads
                if lead.get("assigned_to") in profiles_by_id
                and profiles_by_id[lead["assigned_to"]].get("is_active") is False
            ]
            unresolved = [
                lead["id"]
                for lead in inactive_owned
                if not historical_owner_name(lead, profiles_by_id)
            ]
            self.check(
                "停用人员的历史负责人身份仍可解析",
                not unresolved,
                f"无法解析={unresolved[:5]}",
            )

        ok, count = self.db_count("notifications")
        self.check("notifications 表可访问", ok and isinstance(count, int), str(count))
        if isinstance(count, int):
            self.check("通知未超过 5000 条", count <= 5000, f"{count} 条")

    def run_source_checks(self) -> None:
        proxy_file = PROJECT_ROOT / "src/proxy.ts"
        unread_route = (
            PROJECT_ROOT
            / "src/app/api/notifications/unread-count/route.ts"
        )
        leads_list_route = PROJECT_ROOT / "src/app/api/leads/list/route.ts"

        self.check("proxy.ts 存在", proxy_file.is_file())
        if proxy_file.is_file():
            content = proxy_file.read_text(encoding="utf-8")
            self.check("proxy.ts 记录活跃时间", "last_active_at" in content)
            self.check(
                "proxy.ts 记录审计日志",
                "PAGE_VISIT" in content or "audit_logs" in content,
            )
        self.check("unread-count route.ts 存在", unread_route.is_file())
        self.check("leads list route.ts 存在", leads_list_route.is_file())
        if leads_list_route.is_file():
            content = leads_list_route.read_text(encoding="utf-8")
            self.check(
                "转移候选源码限定 sales/operator/boss",
                '.in("role", ["sales", "operator", "boss"])' in content,
            )
            self.check(
                "转移候选源码限定启用人员",
                '.eq("is_active", true)' in content,
            )

    def write_result(self) -> None:
        result = {
            "pass": self.passed,
            "fail": self.failed,
            "total": self.passed + self.failed,
            "errors": self.errors,
            "timestamp": datetime.now().isoformat(),
        }
        self.result_file.parent.mkdir(parents=True, exist_ok=True)
        self.result_file.write_text(
            json.dumps(result, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--pre-deploy", action="store_true")
    mode.add_argument("--post-deploy", action="store_true")
    mode.add_argument("--daily", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path(os.environ.get("CRM_ENV_FILE", PROJECT_ROOT / ".env.local")),
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("CRM_BASE_URL", "http://localhost:3001"),
    )
    parser.add_argument(
        "--result-file",
        type=Path,
        default=Path(
            os.environ.get(
                "CRM_REGRESSION_RESULT_FILE",
                PROJECT_ROOT / ".audit/crm-regression-latest.json",
            )
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        return run_contract_self_test()

    env = load_env(args.env_file)
    try:
        supabase_url = env["NEXT_PUBLIC_SUPABASE_URL"]
        service_key = env["SUPABASE_SERVICE_ROLE_KEY"]
    except KeyError as error:
        raise RuntimeError(f"missing required environment variable: {error.args[0]}") from error

    mode = (
        "pre-deploy"
        if args.pre_deploy
        else "post-deploy"
        if args.post_deploy
        else "daily"
        if args.daily
        else "manual"
    )
    regression = Regression(
        base_url=args.base_url,
        supabase_url=supabase_url,
        service_key=service_key,
        result_file=args.result_file,
        verbose=args.verbose,
    )
    return regression.run(mode)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - CLI must produce actionable failure evidence
        print(f"CRM regression setup failed: {error}", file=sys.stderr)
        raise SystemExit(2) from error
