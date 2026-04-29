#!/bin/bash
# stream.md — Claude Code PreToolUse hook
# Posts a Markdown fragment describing the tool call.

set -e

input=$(cat)
tool=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[ -z "$tool" ] && exit 0

shortpath() {
  echo "$1" | sed "s|^$HOME/|~/|"
}

trunc() {
  local s="$1"
  local n="$2"
  if [ ${#s} -gt "$n" ]; then
    echo "${s:0:$((n - 1))}…"
  else
    echo "$s"
  fi
}

case "$tool" in
  Edit)
    fp=$(shortpath "$(echo "$input" | jq -r '.tool_input.file_path // ""')")
    old=$(echo "$input" | jq -r '.tool_input.old_string // ""')
    new=$(echo "$input" | jq -r '.tool_input.new_string // ""')
    # Real unified diff. Drop the file headers (--- / +++) since we already show the path.
    # Drop file headers and any trailing blank line.
    diff_body=$(diff -u <(printf '%s' "$old") <(printf '%s' "$new") | tail -n +3 || true)
    diff_body=$(printf '%s' "$diff_body" | sed -e '$ {/^$/d;}')
    md=$(printf '> **Edit** \`%s\`\n\n```diff\n%s\n```' "$fp" "$diff_body")
    ;;
  Write)
    fp=$(shortpath "$(echo "$input" | jq -r '.tool_input.file_path // ""')")
    md="> **Write** \`$fp\`"
    ;;
  Bash)
    cmd=$(echo "$input" | jq -r '.tool_input.command // ""')
    md=$(printf '> **Bash**\n\n```bash\n%s\n```' "$cmd")
    ;;
  Read)
    fp=$(shortpath "$(echo "$input" | jq -r '.tool_input.file_path // ""')")
    md="> **Read** \`$fp\`"
    ;;
  Glob)
    pat=$(echo "$input" | jq -r '.tool_input.pattern // ""')
    md="> **Glob** \`$pat\`"
    ;;
  Grep)
    pat=$(echo "$input" | jq -r '.tool_input.pattern // ""')
    md="> **Grep** \`$pat\`"
    ;;
  WebFetch)
    url=$(echo "$input" | jq -r '.tool_input.url // ""')
    md="> **WebFetch** \`$url\`"
    ;;
  WebSearch)
    q=$(echo "$input" | jq -r '.tool_input.query // ""')
    md="> **WebSearch** \`$q\`"
    ;;
  Task)
    desc=$(echo "$input" | jq -r '.tool_input.description // ""')
    md="> **Task** $desc"
    ;;
  *)
    md="> **$tool**"
    ;;
esac

# cap overall size
if [ ${#md} -gt 4000 ]; then
  md="${md:0:3997}…"
fi

url="${STREAM_MD_URL:-http://localhost:7878}"
channel="${STREAM_MD_CHANNEL:-claude-code}"

printf '%s' "$md" \
  | curl -s --max-time 1 --data-binary @- "$url/$channel/append" > /dev/null 2>&1 || true
