#!/bin/bash
# stream.md — Claude Code PreToolUse hook
# Mirrors Claude Code's allowlist locally so already-permitted tools skip the
# jot gate entirely. Anything not in the allowlist opens a gate and blocks until
# the user decides via jot.

set -e

input=$(cat)
tool=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[ -z "$tool" ] && exit 0
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)

bash_cmd=""
skill_name=""
case "$tool" in
  Bash)  bash_cmd=$(echo "$input"  | jq -r '.tool_input.command // ""') ;;
  Skill) skill_name=$(echo "$input" | jq -r '.tool_input.skill // .tool_input.skill_name // ""') ;;
esac

# --- allowlist matching -------------------------------------------------------

# Built-in safe tools that don't need permission and don't typically appear in
# user allowlists. Keep this conservative.
DEFAULT_ALLOW="TodoWrite Task Skill ExitPlanMode TaskCreate TaskUpdate TaskList TaskGet TaskOutput TaskStop ScheduleWakeup ToolSearch"

is_default_allowed() {
  case " $DEFAULT_ALLOW " in *" $tool "*) return 0 ;; esac
  return 1
}

collect_allow_entries() {
  for f in \
    "$HOME/.claude/settings.json" \
    "$HOME/.claude/settings.local.json" \
    "$cwd/.claude/settings.json" \
    "$cwd/.claude/settings.local.json"; do
    [ -f "$f" ] || continue
    jq -r '.permissions.allow[]? // empty' "$f" 2>/dev/null
  done
}

# Returns 0 if $entry permits the current tool call.
matches_entry() {
  local entry="$1"
  # Bare tool name → allow all invocations of that tool.
  if [ "$entry" = "$tool" ]; then return 0; fi

  # Tool(arg-pattern)
  if [[ "$entry" == "$tool("*")" ]]; then
    local pat="${entry#${tool}(}"
    pat="${pat%)}"
    case "$tool" in
      Bash)
        if [ "$pat" = "*" ]; then return 0; fi
        if [[ "$pat" == *":*" ]]; then
          local prefix="${pat%:\*}"
          case "$bash_cmd" in "$prefix"*) return 0 ;; esac
        elif [ "$pat" = "$bash_cmd" ]; then
          return 0
        fi
        ;;
      Skill)
        [ "$pat" = "*" ] && return 0
        [ "$pat" = "$skill_name" ] && return 0
        ;;
      *)
        [ "$pat" = "*" ] && return 0
        ;;
    esac
    return 1
  fi

  # Suffix wildcard, e.g. mcp__server__*
  if [[ "$entry" == *"*" ]]; then
    local prefix="${entry%\*}"
    case "$tool" in "$prefix"*) return 0 ;; esac
  fi
  return 1
}

is_user_allowed() {
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    matches_entry "$entry" && return 0
  done < <(collect_allow_entries)
  return 1
}

# --- detect allowlisted ------------------------------------------------------

allowlisted=0
if is_default_allowed || is_user_allowed; then
  allowlisted=1
fi

# --- markdown for jot --------------------------------------------------------

shortpath() { echo "$1" | sed "s|^$HOME/|~/|"; }

fp=""; pat=""; web_url=""
case "$tool" in
  Edit)
    fp=$(shortpath "$(echo "$input" | jq -r '.tool_input.file_path // ""')")
    old=$(echo "$input" | jq -r '.tool_input.old_string // ""')
    new=$(echo "$input" | jq -r '.tool_input.new_string // ""')
    case "${fp##*.}" in
      ts|mts|cts) difflang="diff:typescript" ;;
      tsx)        difflang="diff:tsx" ;;
      js|mjs|cjs|jsx) difflang="diff:javascript" ;;
      py)         difflang="diff:python" ;;
      rb)         difflang="diff:ruby" ;;
      go)         difflang="diff:go" ;;
      rs)         difflang="diff:rust" ;;
      swift)      difflang="diff:swift" ;;
      sh|bash|zsh) difflang="diff:bash" ;;
      json)       difflang="diff:json" ;;
      yaml|yml)   difflang="diff:yaml" ;;
      toml)       difflang="diff:ini" ;;
      md|markdown) difflang="diff:markdown" ;;
      html|htm)   difflang="diff:xml" ;;
      css)        difflang="diff:css" ;;
      scss|sass)  difflang="diff:scss" ;;
      sql)        difflang="diff:sql" ;;
      *)          difflang="diff" ;;
    esac
    diff_body=$(diff -u <(printf '%s' "$old") <(printf '%s' "$new") | tail -n +3 || true)
    diff_body=$(printf '%s' "$diff_body" | sed -e '$ {/^$/d;}')
    md=$(printf '> **Edit** \`%s\`\n\n```%s\n%s\n```' "$fp" "$difflang" "$diff_body")
    ;;
  Write)
    fp=$(shortpath "$(echo "$input" | jq -r '.tool_input.file_path // ""')")
    md="> **Write** \`$fp\`"
    ;;
  Bash)
    md=$(printf '> **Bash**\n\n```bash\n%s\n```' "$bash_cmd")
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
    web_url=$(echo "$input" | jq -r '.tool_input.url // ""')
    md="> **WebFetch** \`$web_url\`"
    ;;
  WebSearch)
    q=$(echo "$input" | jq -r '.tool_input.query // ""')
    md="> **WebSearch** \`$q\`"
    ;;
  *)
    args=$(echo "$input" | jq -c '.tool_input // {}')
    if [ -z "$args" ] || [ "$args" = "{}" ] || [ "$args" = "null" ]; then
      md="> **$tool**"
    else
      pretty=$(echo "$input" | jq '.tool_input')
      md=$(printf '> **%s**\n\n```json\n%s\n```' "$tool" "$pretty")
    fi
    ;;
esac

if [ ${#md} -gt 4000 ]; then
  md="${md:0:3997}…"
fi

url="${JOT_URL:-http://localhost:7878}"

. "$(dirname "$0")/_jot-channel.sh"
resolve_jot_channel "$session_id"
channel="$JOT_CHANNEL_RESOLVED"

# Keep the "Thinking…" ephemeral from UserPromptSubmit visible during tool
# execution — don't overwrite it with a tool-specific label.

# Allowlisted or no session → post fragment directly and allow.
# (For gated tools the /gate endpoint posts the fragment itself, so we skip
# this append to avoid duplicates.)
if [ "$allowlisted" = "1" ] || [ -z "$session_id" ]; then
  printf '%s' "$md" \
    | curl -s --max-time 1 --data-binary @- "$url/$channel/append?internal=1" > /dev/null 2>&1 || true
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Open gate. Self-signal shortly after so the gate enters awaiting state without
# depending on the Notification hook (which fires too late and only for some
# tools). The gate then blocks until the user decides via jot, or auto-denies
# after JOT_PERM_TIMEOUT.
timeout_ms="${JOT_PERM_TIMEOUT:-600000}"
key=$(printf 'cc:%s' "$session_id" | sed 's/[^A-Za-z0-9:_.-]/_/g')

(
  sleep 0.2
  curl -s --max-time 2 -X POST --data "" "$url/$channel/signal?key=$key" > /dev/null 2>&1 || true
) &

# Build action set. The hook owns this, so adding new buttons (e.g. "Allow this
# session", "Deny with reason") is a matter of editing this JSON.
actions_json=$(jq -nc '[
  {label:"Allow",        decision:"allow"},
  {label:"Allow always", decision:"allow", remember:true},
  {label:"Deny",         decision:"deny"}
]')

gate_body=$(jq -nc --arg md "$md" --argjson actions "$actions_json" \
  '{markdown:$md, actions:$actions}')

resp=$(printf '%s' "$gate_body" \
  | curl -s --max-time $((timeout_ms / 1000 + 5)) \
         -H "content-type: application/json" \
         --data-binary @- \
         "$url/$channel/gate?key=$key&wait=2000&timeout=$timeout_ms&auto=deny" || true)

decision=$(echo "$resp" | jq -r '.decision // "deny"' 2>/dev/null || echo "deny")
message=$(echo "$resp"  | jq -r '.message  // ""'      2>/dev/null || echo "")
remember=$(echo "$resp" | jq -r '.remember // false'   2>/dev/null || echo "false")

# Persist allowlist entry on "Allow always".
if [ "$decision" = "allow" ] && [ "$remember" = "true" ]; then
  case "$tool" in
    Bash)
      first_word=$(printf '%s' "$bash_cmd" | awk '{print $1}')
      [ -n "$first_word" ] && allow_pattern="Bash($first_word:*)" || allow_pattern="Bash(*)"
      ;;
    Skill)
      [ -n "$skill_name" ] && allow_pattern="Skill($skill_name)" || allow_pattern="Skill"
      ;;
    *)
      allow_pattern="$tool"
      ;;
  esac
  settings_file="$HOME/.claude/settings.local.json"
  if [ -f "$settings_file" ]; then
    tmp=$(mktemp)
    if jq --arg p "$allow_pattern" \
         '.permissions.allow = ((.permissions.allow // []) + [$p] | unique)' \
         "$settings_file" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$settings_file"
    else
      rm -f "$tmp"
    fi
  fi
fi

if [ "$decision" = "allow" ]; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
else
  reason="${message:-denied via jot}"
  jq -nc --arg msg "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$msg}}'
fi
