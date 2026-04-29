#!/bin/bash
# stream.md — Claude Code Stop hook
# Posts the last assistant message of the just-finished turn to stream.md.

set -e

input=$(cat)

url="${JOT_URL:-http://localhost:7878}"

. "$(dirname "$0")/_jot-channel.sh"
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
resolve_jot_channel "$session_id"
channel="$JOT_CHANNEL_RESOLVED"

# Always clear ephemerals (e.g. "Thinking…") on turn end, even if there's no
# final assistant text to post.
printf '' | curl -s --max-time 1 --data-binary @- "$url/$channel/ephemeral" > /dev/null 2>&1 || true

# Stop hook payload includes `last_assistant_message` directly.
text=$(echo "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)
[ -z "$text" ] && exit 0

printf '%s' "$text" \
  | curl -s --max-time 2 --data-binary @- "$url/$channel/append?internal=1" > /dev/null 2>&1 || true
