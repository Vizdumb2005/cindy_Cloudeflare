#!/usr/bin/env bash
# Cindy hands bootstrap — idempotent, safe to re-run every cycle.
# Usage: bootstrap.sh <CINDY_URL> <BOOTSTRAP_TOKEN>
set -euo pipefail

CINDY_URL="${1:-${CINDY_URL:-}}"
BOOTSTRAP_TOKEN="${2:-${CINDY_NODE_BOOTSTRAP_TOKEN:-}}"
WORK=/kaggle/working
STATE="$WORK/state"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -z "$CINDY_URL" ] && { echo "ERROR: CINDY_URL not provided" >&2; exit 1; }
[ -z "$BOOTSTRAP_TOKEN" ] && { echo "ERROR: BOOTSTRAP_TOKEN not provided" >&2; exit 1; }

mkdir -p "$STATE/node" "$STATE/park"

# Restore previous state if present (no-op on first cycle).
if [ -d "$WORK/input/state" ] && [ ! -f "$STATE/.restored" ]; then
  echo "cindy: restoring previous cycle state"
  cp -a "$WORK/input/state/." "$STATE/" || true
  touch "$STATE/.restored"
fi

# Device identity: minted once, never regenerated.
DEVICE_FILE="$STATE/node/device.json"
if [ ! -f "$DEVICE_FILE" ]; then
  DEVICE_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')"
  echo "{\"device_id\": \"$DEVICE_ID\", \"created_at\": $(date +%s)}" > "$DEVICE_FILE"
  echo "cindy: minted device_id $DEVICE_ID"
fi
DEVICE_ID="$(python3 -c 'import json;print(json.load(open("'"$DEVICE_FILE"'"))["device_id"])')"

# Node agent: copy self-adjacent cindy-node.mjs into place, write config.
cp -f "$HERE/cindy-node.mjs" "$STATE/node/cindy-node.mjs"
cat > "$STATE/node/config.json" <<EOF_CFG
{
  "url": "$CINDY_URL",
  "token": "$BOOTSTRAP_TOKEN",
  "device_id": "$DEVICE_ID",
  "caps": ["shell", "browser", "files"]
}
EOF_CFG

# Node 20 runtime (Kaggle images ship Node; install only if missing).
if ! command -v node >/dev/null 2>&1 || ! node -v 2>/dev/null | grep -q 'v2[0-9]'; then
  echo "cindy: installing Node 20"
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
fi
if command -v npm >/dev/null 2>&1; then
  (cd "$STATE/node" && npm install --no-audit --no-fund ws >/dev/null 2>&1 || true)
fi

# tmux supervisor
command -v tmux >/dev/null 2>&1 || apt-get install -y -qq tmux >/dev/null 2>&1 || true
tmux kill-session -t cindy 2>/dev/null || true
tmux new-session -d -s cindy "cd $STATE/node && node cindy-node.mjs"

# 15-min snapshot cron (flock-guarded): tar state -> R2 via rclone + git mirror.
cat > "$STATE/node/snapshot.sh" <<EOF_SNAP
#!/usr/bin/env bash
set -euo pipefail
flock -n /tmp/cindy-snap.lock || exit 0
CYCLE_ID="\$(cat "$STATE/node/device.json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("cycle_id","unknown"))' 2>/dev/null || echo unknown)"
tar czf /tmp/state.tgz -C "$WORK" state
if command -v rclone >/dev/null 2>&1 && [ -n "\${R2_S3_ACCESS_KEY_ID:-}" ]; then
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="\$R2_S3_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="\$R2_S3_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="https://\${R2_ACCOUNT_ID:-}.r2.cloudflarestorage.com"
  rclone copy /tmp/state.tgz "r2:cindy-artifacts/snapshots/\$CYCLE_ID/" >/dev/null 2>&1 || true
fi
if [ -d "$WORK/state-mirror/.git" ]; then
  cp /tmp/state.tgz "$WORK/state-mirror/state.tgz"
  cd "$WORK/state-mirror" && git add state.tgz && git commit -qm "snapshot \$CYCLE_ID" || true
fi
echo "snapshot done \$CYCLE_ID"
EOF_SNAP
chmod +x "$STATE/node/snapshot.sh"
( crontab -l 2>/dev/null | grep -v snapshot.sh; echo "*/15 * * * * $STATE/node/snapshot.sh" ) | crontab - 2>/dev/null || true

echo "cindy: node agent started under tmux session 'cindy'"
echo "cindy: device_id=$DEVICE_ID url=$CINDY_URL"
echo "cindy: next steps — 'tmux attach -t cindy' to watch; approve the device in the panel pairing queue."
exit 0
