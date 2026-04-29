#!/bin/bash
# stream.md — Claude Code Notification hook
# Posts permission asks / idle prompts to the channel.

set -e

input=$(cat)
echo "$(date) $input" >> /tmp/stream-md-notify.log

msg=$(echo "$input" | jq -r '.message // empty' 2>/dev/null)
[ -z "$msg" ] && exit 0

# If tool info is present, include it
tool=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)
extra=""
if [ -n "$tool" ]; then
  case "$tool" in
    Bash) cmd=$(echo "$input" | jq -r '.tool_input.command // ""'); extra=$'\n\n```bash\n'"$cmd"$'\n```' ;;
    Edit|Write|Read) fp=$(echo "$input" | jq -r '.tool_input.file_path // ""'); extra=" \`$fp\`" ;;
    *) extra=" (${tool})" ;;
  esac
fi

md="> ⚠ ${msg}${extra}"

url="${JOT_URL:-http://localhost:7878}"

. "$(dirname "$0")/_jot-channel.sh"
sid=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
resolve_jot_channel "$sid"
channel="$JOT_CHANNEL_RESOLVED"

# If this notification is tied to a session that has a pending /gate, escalate it.
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
if [ -n "$session_id" ]; then
  key=$(printf 'cc:%s' "$session_id" | sed 's/[^A-Za-z0-9:_.-]/_/g')
  resp=$(printf '%s' "$md" \
    | curl -s --max-time 2 --data-binary @- "$url/$channel/signal?key=$key" || true)
  matched=$(echo "$resp" | jq -r '.matched // false' 2>/dev/null || echo "false")
  if [ "$matched" = "true" ]; then
    exit 0
  fi
fi

# No matching gate — fall back to a plain notice.
printf '%s' "$md" \
  | curl -s --max-time 1 --data-binary @- "$url/$channel/append?internal=1" > /dev/null 2>&1 || true
