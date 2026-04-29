# jot

Post Markdown fragments over HTTP. Read them flowing in your browser.

```bash
bun install
bun start                # http://localhost:7878/<channel>
# or, for hot-reloading frontend dev:
bun run dev              # spawns Bun API + Vite (http://localhost:5173)
```

Push a fragment:

```bash
echo "## hello" | curl -s --data-binary @- localhost:7878/claude-code/append
```

Channels are created on first POST. In-memory only — fragments vanish when the server stops. Each channel keeps the most recent 500 fragments.

## API

- `POST /:channel/append` — body is Markdown
- `POST /:channel/status` — body is a label string ("thinking…", "building…", …); empty/`off`/`0` clears
- `POST /:channel/permission` — body is Markdown; long-polls until the browser POSTs `/decide/:id`. Response: `{id, decision:"allow"|"deny", message?}` or 408 timeout. Optional `?timeout=ms` (default 600000).
- `POST /:channel/decide/:id` — body `{decision:"allow"|"deny", message?}`. Browser sends this when the user clicks Allow/Deny.
- `GET /:channel` — JSON of fragments (HTML if browser)
- `GET /:channel/stream` — SSE stream of `{type:"fragment"|"status"|"decided", ...}` events (backlog + live)
- `GET /:channel/wait?since=<id>&timeout=<ms>` — long-poll for the next non-internal fragment (used by the MCP bridge).
- `GET /channels` — list with counts

## Rendering

- Markdown via `marked`
- ` ```diff ` and ` ```diff:<lang> ` blocks: red/green per-line with word-level intra-line highlighting, supports `@@` hunk headers; with `:<lang>` the inner code is syntax-highlighted
- ` ```bash ` and other languages registered in `src/ui/App.tsx`: syntax-highlighted via highlight.js

## Claude Code hooks

The `scripts/` directory has hooks that wire Claude Code to a `claude-code` channel:

| Hook | Script | What it does |
|---|---|---|
| `UserPromptSubmit` | `claude-typing.sh` | Posts the user prompt (truncated) and sets status to `thinking…` |
| `Stop` | `claude-hook.sh` | Posts the assistant's text reply, clears the status |
| `PreToolUse` | `claude-tool.sh` | Posts a Markdown fragment per tool call (Edit shows a real `diff -u`) |
| `Notification` | `claude-notify.sh` | Posts permission asks / idle alerts |

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/jot/scripts/claude-typing.sh" }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/jot/scripts/claude-hook.sh"   }] }],
    "PreToolUse":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/jot/scripts/claude-tool.sh"   }] }],
    "Notification":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/jot/scripts/claude-notify.sh" }] }]
  }
}
```

Override the channel or label via env: `JOT_URL`, `JOT_CHANNEL`, `JOT_STATUS`.

Both Claude Code and Codex hooks use the shared channel resolver in
`scripts/_jot-channel.sh`. By default, the first prompt of a session becomes a
short channel slug; later hooks with the same `session_id` reuse that channel.
Set `JOT_CHANNEL` to force one fixed channel across all agents.

## Claude Code plugin (MCP bridge)

This repo ships as a [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins): the plugin's MCP server bridges a jot channel into Claude Code via the experimental `claude/channel` capability. Browser fragments arrive as `<channel source="jot" channel="..." id="..." ts="...">` ambient messages, and Claude replies via the `reply` tool — markdown is appended to the same channel and rendered live in the browser.

### Layout

```
.claude-plugin/marketplace.json     # local marketplace manifest
plugins/jot/
  .claude-plugin/plugin.json        # plugin manifest
  .mcp.json                         # MCP server registration
  package.json                      # bun start → server.ts
  server.ts                         # MCP server (stdio)
```

### Install as a local plugin

Add this repo as a marketplace, then install the `jot` plugin:

```bash
# from inside Claude Code
/plugin marketplace add /path/to/jot
/plugin install jot@jot
```

Or from GitHub once published:

```bash
/plugin marketplace add moeki0/jot
/plugin install jot@jot
```

The plugin's `.mcp.json` is auto-loaded when the plugin is enabled — no manual `~/.claude/.mcp.json` edits needed. It runs `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --silent start`, which `bun install`s on first launch and then `bun server.ts`.

### Tools

| Tool | Description |
|---|---|
| `reply` | Post a markdown fragment back to the jot channel. Self-posted ids are not redelivered as channel events. |
| `list_channels` | List jot channels with fragment counts. |

### Configuration

The MCP server reads:

- `JOT_URL` — base URL of the jot HTTP server (default `http://localhost:7878`)
- `JOT_CHANNEL` — channel name to bridge (default `claude-code`)

Make sure the jot server is running (`bun start`) on the same machine, on the URL the plugin points to.

