#!/bin/bash
# kadai:name Containers
# kadai:emoji 📦
# kadai:description List running containers, then tail logs or shell into one

set -euo pipefail

DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
DOCKER_API="http://localhost/v1.43"
BH_API="http://127.0.0.1:${PORT:-3000}/api/v1"
KILL_ALL=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kill-all) KILL_ALL=true; shift ;;
    --dry-run)  DRY_RUN=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- Preflight checks ---

for cmd in jq curl docker; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 1
  fi
done

if ! docker info &>/dev/null; then
  echo "Error: Docker daemon is not running or not accessible." >&2
  echo "Hint: Start Docker Desktop or run: sudo systemctl start docker" >&2
  exit 1
fi

# --- Fetch running containers from docker ---

CONTAINERS=$(curl -sf --unix-socket "$DOCKER_SOCKET" "$DOCKER_API/containers/json?all=false") || {
  echo "Error: Failed to query Docker API." >&2
  exit 1
}

COUNT=$(echo "$CONTAINERS" | jq 'length')
if [ "$COUNT" -eq 0 ]; then
  echo "No running containers."
  exit 0
fi

# --- Kill all containers ---

kill_all_containers() {
  local ids
  ids=$(echo "$CONTAINERS" | jq -r '.[].Id')

  echo "Stopping $COUNT container(s)..."

  local failed=0
  while IFS= read -r cid; do
    local short="${cid:0:12}"
    if [ "$DRY_RUN" = true ]; then
      echo "  [dry-run] Would stop and remove $short"
    else
      if docker stop -t 10 "$cid" &>/dev/null; then
        docker rm "$cid" &>/dev/null 2>&1 || true
        echo "  Stopped $short"
      else
        echo "  Failed to stop $short" >&2
        failed=$((failed + 1))
      fi
    fi
  done <<< "$ids"

  if [ "$DRY_RUN" = true ]; then
    echo "Dry run complete. No containers were stopped."
  elif [ "$failed" -eq 0 ]; then
    echo "All containers stopped."
  else
    echo "$failed container(s) failed to stop." >&2
    exit 1
  fi
}

if [ "$KILL_ALL" = true ]; then
  kill_all_containers
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

# Build tab-separated display lines from docker container data + labels.
# Fields: FULL_ID \t WORKLOAD \t TENANT \t IMAGE \t PORTS
LINES=$(echo "$CONTAINERS" | jq -r --argjson tenants "$TENANT_MAP" '
  .[] |
  .Names[0] as $name |
  [
    .Id,
    ((.Labels // {})["boilerhouse.workload"] // "-"),
    ($tenants[($name | ltrimstr("/"))] // "-"),
    ((.Image // "<none>") | split("/") | .[-1]),
    ((.Ports // []) | map(select(.PublicPort > 0) | "\(.PublicPort)->\(.PrivatePort)") | join(", ") | if . == "" then "-" else . end)
  ] | @tsv
')

# --- Select a container ---

pick_container() {
  if command -v fzf &>/dev/null; then
    local header formatted
    header=$(printf "%-20s %-20s %-28s %s\n%s" "WORKLOAD" "TENANT" "IMAGE" "PORTS" "ctrl-k: kill all")
    formatted=$(echo "$LINES" | while IFS=$'\t' read -r full_id workload tenant image ports; do
      printf "%-20s %-20s %-28s %s\n" "$workload" "$tenant" "$image" "$ports"
    done)
    local selected exit_code
    selected=$(echo "$formatted" | fzf --header="$header" --reverse --no-sort \
      --bind "ctrl-k:become(echo __KILL_ALL__)") || exit_code=$?
    if [ "$selected" = "__KILL_ALL__" ]; then
      echo "__KILL_ALL__"
      return 0
    fi
    [ "${exit_code:-0}" -ne 0 ] && return 1
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
    echo "  k) Kill all containers ($COUNT)"
    echo ""
    read -rp "Select container [1-${#full_ids[@]}, k=kill all]: " choice
    if [ "$choice" = "k" ] || [ "$choice" = "K" ]; then
      echo "__KILL_ALL__"
    elif [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#full_ids[@]}" ]; then
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

if [ "$CONTAINER_ID" = "__KILL_ALL__" ]; then
  read -rp "Stop all $COUNT container(s)? [y/N] " confirm
  if [[ "$confirm" =~ ^[yY]$ ]]; then
    kill_all_containers
  else
    echo "Cancelled."
  fi
  exit 0
fi

# Resolve a human-readable label for the selected container
CONTAINER_WORKLOAD=""
CONTAINER_LABEL=""
while IFS=$'\t' read -r full_id workload tenant image ports; do
  if [ "$full_id" = "$CONTAINER_ID" ]; then
    CONTAINER_WORKLOAD="$workload"
    if [ "$workload" != "-" ]; then
      CONTAINER_LABEL="$workload"
    else
      CONTAINER_LABEL="${full_id:0:12}"
    fi
    break
  fi
done <<< "$LINES"

# --- Select action ---

pick_action() {
  local actions="Tail logs\nShell (exec)"
  local action_count=2

  if [ "$CONTAINER_WORKLOAD" = "openclaw" ]; then
    actions="$actions\n─── openclaw ───\nApprove device claims"
    action_count=3
  fi

  if command -v fzf &>/dev/null; then
    printf "$actions\n" | fzf --reverse --no-sort --header="Action for $CONTAINER_LABEL"
  else
    echo ""
    echo "Actions for $CONTAINER_LABEL:"
    echo "  1) Tail logs"
    echo "  2) Shell (exec)"
    if [ "$CONTAINER_WORKLOAD" = "openclaw" ]; then
      echo "  ─── openclaw ───"
      echo "  3) Approve device claims"
    fi
    echo ""
    read -rp "Select action [1-${action_count}]: " choice
    case "$choice" in
      1) echo "Tail logs" ;;
      2) echo "Shell (exec)" ;;
      3)
        if [ "$CONTAINER_WORKLOAD" = "openclaw" ]; then
          echo "Approve device claims"
        else
          return 1
        fi
        ;;
      *) return 1 ;;
    esac
  fi
}

ACTION=$(pick_action) || { echo "No action selected."; exit 0; }

case "$ACTION" in
  "Tail logs"*)
    echo "Tailing logs for $CONTAINER_LABEL... (Ctrl+C to stop)"
    echo ""
    exec docker logs -f "$CONTAINER_ID"
    ;;
  "Shell"*)
    echo "Opening shell in $CONTAINER_LABEL..."
    exec docker exec -it "$CONTAINER_ID" /bin/sh
    ;;
  "Approve device claims"*)
    echo "Approving device claims for $CONTAINER_LABEL..."
    exec docker exec -it "$CONTAINER_ID" node openclaw.mjs devices approve
    ;;
  *)
    echo "No action selected."
    exit 0
    ;;
esac
