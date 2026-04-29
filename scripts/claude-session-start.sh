#!/bin/bash
# SessionStart hook — ensure a jot channel exists for this Claude Code session
# by appending a session-start marker.

set -e

input=$(cat)

url="${JOT_URL:-http://localhost:7878}"

. "$(dirname "$0")/_jot-channel.sh"
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
resolve_jot_channel "$session_id"
channel="$JOT_CHANNEL_RESOLVED"

printf '— session started —' \
  | curl -s --max-time 2 --data-binary @- "$url/$channel/append?internal=1" > /dev/null 2>&1 || true
