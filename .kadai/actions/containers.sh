#!/bin/bash
# kadai:name Containers
# kadai:emoji 📦
# kadai:description List running containers, then tail logs or shell into one

set -euo pipefail

SOCKET_PATH="${PODMAN_SOCKET:-/run/boilerhouse/podman.sock}"
PODMAN_API="http://d/v5.0.0/libpod"
BH_API="http://127.0.0.1:${PORT:-3000}/api/v1"

# --- Preflight checks ---

for cmd in jq curl podman; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 1
  fi
done

if ! [ -S "$SOCKET_PATH" ]; then
  echo "Error: Podman socket not found at $SOCKET_PATH" >&2
  echo "Hint: kadai run daemon" >&2
  exit 1
fi

# --- Fetch running containers from podman ---

CONTAINERS=$(curl -sf --unix-socket "$SOCKET_PATH" "$PODMAN_API/containers/json?all=false") || {
  echo "Error: Failed to query podman API." >&2
  exit 1
}

COUNT=$(echo "$CONTAINERS" | jq 'length')
if [ "$COUNT" -eq 0 ]; then
  echo "No running containers."
  exit 0
fi

# --- Fetch tenant info from boilerhouse API (best-effort) ---

TENANT_MAP="{}"
INSTANCES_JSON=$(curl -sf "$BH_API/instances?status=active" 2>/dev/null) || true
if [ -n "$INSTANCES_JSON" ]; then
  # Build instance -> tenantId lookup
  TENANT_MAP=$(echo "$INSTANCES_JSON" | jq '
    [ .[] | select(.tenantId != null) | { key: .instanceId, value: .tenantId } ]
    | from_entries
  ')
fi

# Build tab-separated display lines from podman container data + labels.
# Fields: FULL_ID \t WORKLOAD \t TENANT \t IMAGE \t PORTS
LINES=$(echo "$CONTAINERS" | jq -r --argjson tenants "$TENANT_MAP" '
  .[] |
  .Names[0] as $name |
  [
    .Id,
    ((.Labels // {})["boilerhouse.workload"] // "-"),
    ($tenants[$name] // "-"),
    ((.Image // "<none>") | split("/") | .[-1]),
    ((.Ports // []) | map(select(.hostPort > 0) | "\(.hostPort)->\(.containerPort)") | join(", ") | if . == "" then "-" else . end)
  ] | @tsv
')

# --- Select a container ---

pick_container() {
  if command -v fzf &>/dev/null; then
    local header formatted
    header=$(printf "%-20s %-20s %-28s %s" "WORKLOAD" "TENANT" "IMAGE" "PORTS")
    formatted=$(echo "$LINES" | while IFS=$'\t' read -r full_id workload tenant image ports; do
      printf "%-20s %-20s %-28s %s\n" "$workload" "$tenant" "$image" "$ports"
    done)
    local selected
    selected=$(echo "$formatted" | fzf --header="$header" --reverse --no-sort) || return 1
    # fzf selection index matches LINES order — find the matching line
    local selected_line
    selected_line=$(echo "$formatted" | grep -nxF "$selected" | head -1 | cut -d: -f1)
    echo "$LINES" | sed -n "${selected_line}p" | cut -f1
  else
    local -a full_ids=() display_labels=()
    while IFS=$'\t' read -r full_id workload tenant image ports; do
      full_ids+=("$full_id")
      display_labels+=("$workload  tenant=$tenant  $image  $ports")
    done <<< "$LINES"

    echo "Running containers:"
    echo ""
    local i
    for i in "${!display_labels[@]}"; do
      printf "  %d) %s\n" "$((i + 1))" "${display_labels[$i]}"
    done
    echo ""
    read -rp "Select container [1-${#full_ids[@]}]: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#full_ids[@]}" ]; then
      echo "${full_ids[$((choice - 1))]}"
    else
      return 1
    fi
  fi
}

CONTAINER_ID=$(pick_container) || { echo "No container selected."; exit 0; }

if [ -z "$CONTAINER_ID" ]; then
  echo "No container selected."
  exit 0
fi

# Resolve a human-readable label for the selected container
CONTAINER_LABEL=$(echo "$LINES" | while IFS=$'\t' read -r full_id workload tenant image ports; do
  if [ "$full_id" = "$CONTAINER_ID" ]; then
    if [ "$workload" != "-" ]; then
      echo "$workload"
    else
      echo "${full_id:0:12}"
    fi
    break
  fi
done)

# --- Select action ---

pick_action() {
  if command -v fzf &>/dev/null; then
    printf "Tail logs\nShell (exec)\n" | fzf --reverse --no-sort --header="Action for $CONTAINER_LABEL"
  else
    echo ""
    echo "Actions for $CONTAINER_LABEL:"
    echo "  1) Tail logs"
    echo "  2) Shell (exec)"
    echo ""
    read -rp "Select action [1-2]: " choice
    case "$choice" in
      1) echo "Tail logs" ;;
      2) echo "Shell (exec)" ;;
      *) return 1 ;;
    esac
  fi
}

ACTION=$(pick_action) || { echo "No action selected."; exit 0; }

export CONTAINER_HOST="unix://$SOCKET_PATH"

case "$ACTION" in
  "Tail logs"*)
    echo "Tailing logs for $CONTAINER_LABEL... (Ctrl+C to stop)"
    echo ""
    exec podman logs -f "$CONTAINER_ID"
    ;;
  "Shell"*)
    echo "Opening shell in $CONTAINER_LABEL..."
    exec podman exec -it "$CONTAINER_ID" /bin/sh
    ;;
  *)
    echo "No action selected."
    exit 0
    ;;
esac
