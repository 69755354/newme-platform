#!/bin/bash
# incident-review.sh — 查看最近的故障现场
# 路径: /opt/hermes-scripts/observability/incident-review.sh
# 用法: incident-review.sh            # 列出最近 10 个 incident
#       incident-review.sh <id>       # 查看指定 incident 的完整内容
#       incident-review.sh <id> <file> # 查看指定 incident 的某个文件

INCIDENT_DIR="/tmp/hermes/incidents"

list_incidents() {
  if [ ! -d "$INCIDENT_DIR" ]; then
    echo "📭 无故障记录 (${INCIDENT_DIR} 不存在)"
    return
  fi

  echo "=== 最近故障现场 ==="
  echo ""
  
  count=0
  for dir in $(find "$INCIDENT_DIR" -name "README.txt" -type f | sort -r | head -10); do
    incident_path=$(dirname "$dir")
    incident_name=$(basename "$incident_path")
    date_part=$(basename "$(dirname "$incident_path")")
    readme="$dir"
    
    # 提取摘要
    time_line=$(grep "^Time:" "$readme" 2>/dev/null || echo "Unknown")
    summary=$(grep "^Summary:" "$readme" 2>/dev/null || echo "No summary")
    file_count=$(ls "$incident_path" 2>/dev/null | wc -l)
    
    printf "[%s] %s | %s | %s files\n" "$date_part" "$incident_name" "$summary" "$file_count"
    count=$((count + 1))
  done
  
  if [ "$count" -eq 0 ]; then
    echo "📭 无故障记录"
  fi
}

view_incident() {
  local incident_id="$1"
  local match=$(find "$INCIDENT_DIR" -type d -name "*${incident_id}*" | head -1)
  
  if [ -z "$match" ]; then
    echo "❌ 未找到 incident: $incident_id"
    echo "用 incident-review.sh (无参数) 查看列表"
    exit 1
  fi
  
  local specific_file="${2:-}"
  
  if [ -n "$specific_file" ]; then
    local file_path="${match}/${specific_file}"
    if [ -f "$file_path" ]; then
      cat "$file_path"
    else
      echo "❌ 文件不存在: $specific_file"
      echo "可用文件:"
      ls "$match"
    fi
    return
  fi
  
  echo "=== Incident: $(basename "$match") ==="
  echo ""
  
  if [ -f "${match}/README.txt" ]; then
    cat "${match}/README.txt"
  fi
  
  echo ""
  echo "--- 文件列表 ---"
  ls -la "$match" | grep -v README
}

# 主逻辑
if [ $# -eq 0 ]; then
  list_incidents
else
  view_incident "$1" "${2:-}"
fi
