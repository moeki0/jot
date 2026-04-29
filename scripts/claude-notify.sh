#!/bin/bash
# stream.md — Claude Code Notification hook
# Posts permission asks / idle prompts to the channel.

set -e

input=$(cat)
msg=$(echo "$input" | jq -r '.message // empty' 2>/dev/null)
[ -z "$msg" ] && exit 0

md="> ⚠ ${msg}"

url="${STREAM_MD_URL:-http://localhost:7878}"
channel="${STREAM_MD_CHANNEL:-claude-code}"

printf '%s' "$md" \
  | curl -s --max-time 1 --data-binary @- "$url/$channel/append" > /dev/null 2>&1 || true
