#!/bin/bash
# stream.md — Claude Code Stop hook
# Posts the last assistant message of the just-finished turn to stream.md.

set -e

input=$(cat)

# Stop hook payload includes `last_assistant_message` directly.
text=$(echo "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)
[ -z "$text" ] && exit 0

url="${STREAM_MD_URL:-http://localhost:7878}"
channel="${STREAM_MD_CHANNEL:-claude-code}"

printf '%s' "$text" \
  | curl -s --max-time 2 --data-binary @- "$url/$channel/append" > /dev/null 2>&1 || true

# Clear status now that the assistant turn is done.
printf '' | curl -s --max-time 1 --data-binary @- "$url/$channel/status" > /dev/null 2>&1 || true
