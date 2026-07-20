#!/bin/bash
# incident-capture.sh — 故障现场快照
# 被 health-check.sh / login-probe.sh 在检测到异常时调用
# 路径: /opt/hermes-scripts/observability/incident-capture.sh
# 用法: incident-capture.sh <trigger_name> <alert_summary>

set -euo pipefail

TRIGGER="${1:-unknown}"
SUMMARY="${2:-no details}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DATE_DIR=$(date +"%Y-%m-%d")
TIME_DIR=$(date +"%H%M%S")
INCIDENT_DIR="/tmp/hermes/incidents/${DATE_DIR}/${TIME_DIR}-${TRIGGER}"

mkdir -p "$INCIDENT_DIR"

echo "=== INCIDENT: ${TRIGGER} ==="           >  "${INCIDENT_DIR}/README.txt"
echo "Time: ${TIMESTAMP}"                     >> "${INCIDENT_DIR}/README.txt"
echo "Summary: ${SUMMARY}"                    >> "${INCIDENT_DIR}/README.txt"
echo ""                                        >> "${INCIDENT_DIR}/README.txt"

# ─── 1. 服务日志 (最近 3 分钟) ───
journalctl -u newme-platform --since "3 min ago" --no-pager 2>/dev/null | tail -100 \
  > "${INCIDENT_DIR}/newme-platform.journal" 2>/dev/null || true

journalctl -u hermes-bridge --since "3 min ago" --no-pager 2>/dev/null | tail -50 \
  > "${INCIDENT_DIR}/hermes-bridge.journal" 2>/dev/null || true

journalctl -u hermes-worker --since "3 min ago" --no-pager 2>/dev/null | tail -50 \
  > "${INCIDENT_DIR}/hermes-worker.journal" 2>/dev/null || true

# ─── 2. 系统状态快照 ───
{
  echo "=== DISK ===" && df -h
  echo "=== MEMORY ===" && free -h
  echo "=== CPU ===" && top -bn1 | head -20
  echo "=== PROCESSES (top 15 by mem) ===" && ps aux --sort=-%mem | head -16
  echo "=== NETWORK ===" && ss -tlnp 2>/dev/null | head -20
  echo "=== SYSTEMD FAILED ===" && systemctl --failed --no-pager 2>/dev/null || true
} > "${INCIDENT_DIR}/system-state.txt" 2>/dev/null

# ─── 3. 最近的 Herems 日志 ───
if [ -f /tmp/hermes/health-check.log ]; then
  tail -20 /tmp/hermes/health-check.log > "${INCIDENT_DIR}/recent-health-check.log" 2>/dev/null || true
fi
if [ -f /tmp/hermes/login-probe.log ]; then
  tail -10 /tmp/hermes/login-probe.log > "${INCIDENT_DIR}/recent-login-probe.log" 2>/dev/null || true
fi

# ─── 4. 最近 git 部署记录 ───
if [ -d /home/ubuntu/newme-platform ]; then
  git -C /home/ubuntu/newme-platform log --oneline -5 > "${INCIDENT_DIR}/recent-deploys.txt" 2>/dev/null || true
fi

# ─── 5. 汇总 ───
echo "Incident captured: ${INCIDENT_DIR}"
echo "Files: $(ls ${INCIDENT_DIR} | wc -l)"

# 保留最近 100 个 incident，清理旧的
find /tmp/hermes/incidents/ -maxdepth 2 -type d -mtime +7 -exec rm -rf {} \; 2>/dev/null || true

exit 0
