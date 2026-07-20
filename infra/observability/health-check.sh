#!/bin/bash
# health-check.sh — NewMe 基础设施监控
# 路径: /opt/hermes-scripts/observability/health-check.sh
# crontab: */3 * * * * /bin/bash /opt/hermes-scripts/observability/health-check.sh
# 依赖: curl, bc (apt-get install -y bc)

set -euo pipefail

HOSTNAME=$(hostname)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
ALERTS=""

# ─── 1. 磁盘使用率 ───
DISK_PCT=$(df -h / | awk 'NR==2 {gsub(/%/,""); print $5}')
if [ "$DISK_PCT" -gt 90 ]; then
  ALERTS="${ALERTS}[DISK_CRITICAL] / 使用率 ${DISK_PCT}% (阈值 90%)\n"
elif [ "$DISK_PCT" -gt 80 ]; then
  ALERTS="${ALERTS}[DISK_WARN] / 使用率 ${DISK_PCT}% (阈值 80%)\n"
fi

# ─── 2. 内存使用率 ───
MEM_PCT=$(free | awk '/Mem:/ {printf "%.0f", $3/$2*100}')
if [ "$MEM_PCT" -gt 85 ]; then
  ALERTS="${ALERTS}[MEM_CRITICAL] 内存使用率 ${MEM_PCT}% (阈值 85%)\n"
elif [ "$MEM_PCT" -gt 75 ]; then
  ALERTS="${ALERTS}[MEM_WARN] 内存使用率 ${MEM_PCT}% (阈值 75%)\n"
fi

# ─── 3. CPU 负载 (1min) ───
CPU_LOAD=$(uptime | awk -F'load average:' '{print $2}' | awk -F',' '{print $1}' | xargs)
CORES=$(nproc)
CPU_PCT=$(echo "scale=0; $CPU_LOAD / $CORES * 100" | bc)
if [ "$CPU_PCT" -gt 90 ]; then
  ALERTS="${ALERTS}[CPU_CRITICAL] 负载 ${CPU_LOAD} (${CORES}核, ${CPU_PCT}%)\n"
fi

# ─── 4. 进程数 ───
PROC_COUNT=$(ps aux | wc -l)
if [ "$PROC_COUNT" -gt 500 ]; then
  ALERTS="${ALERTS}[PROC_WARN] 进程数 ${PROC_COUNT} (阈值 500)\n"
fi

# ─── 5. 服务健康检查 ───
if ! curl -sf --max-time 5 http://localhost:3001/api/health > /dev/null 2>&1; then
  ALERTS="${ALERTS}[SERVICE_DOWN] newme-platform:3001 无响应 (5s 超时)\n"
fi

# ─── 6. Hermes 三服务检查 ───
for svc in hermes-bridge hermes-dashboard hermes-worker; do
  if ! systemctl is-active --quiet "$svc" 2>/dev/null; then
    ALERTS="${ALERTS}[HERMES_DOWN] $svc 服务未运行\n"
  fi
done

# ─── 输出 ───
if [ -z "$ALERTS" ]; then
  echo "[$TIMESTAMP] 💓 $HOSTNAME OK | disk=${DISK_PCT}% mem=${MEM_PCT}% cpu=${CPU_PCT}% proc=${PROC_COUNT}"
else
  echo "[$TIMESTAMP] 🔔 $HOSTNAME ALERTS:"
  echo -e "$ALERTS"
  # 抓故障现场
  /opt/hermes-scripts/observability/incident-capture.sh "health-check" "$(echo -e "$ALERTS" | head -1)" &
fi

exit 0
