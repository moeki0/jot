# jot

[![Image from Gyazo](https://i.gyazo.com/11149fd588bb11f7fde05276cfab49af.jpg)](https://gyazo.com/11149fd588bb11f7fde05276cfab49af)


Post Markdown fragments over HTTP. Read them flowing in your browser.

Install via Homebrew:

```bash
brew install moeki0/jot/jot
jot                      # http://localhost:7878/<channel>  (same as `jot serve`)
```

Or from source:

```bash
bun install
npm link                 # exposes the `jot` CLI on PATH
jot                      # http://localhost:7878/<channel>  (same as `jot serve`)
# or, for hot-reloading frontend dev:
bun run dev              # spawns Bun API + Vite (http://localhost:5173)
```

Push a fragment:

```bash
echo "## hello" | jot append claude-code
# equivalent to:
echo "## hello" | curl -s --data-binary @- localhost:7878/claude-code/append
```

`jot` subcommands (all read stdin where applicable, all best-effort/silent):

| Command | Effect |
|---|---|
| `jot` / `jot serve` | start the HTTP server |
| `jot append <channel>` | POST stdin to `/:channel/append?internal=1` |
| `jot ephemeral <channel> [key]` | POST stdin to `/:channel/ephemeral[?key=...]` |
| `jot signal <channel> <key>` | POST to `/:channel/signal?key=...` |
| `jot claude hook <name>` | Run a Claude Code hook handler (`stop`/`user-prompt`/`tool`/`notify`/`session-start`) |
| `jot claude bridge [...args]` | Start the persistent claude-bridge daemon (extra args forwarded to `claude`) |

Honors `JOT_URL` (default `http://localhost:7878`).

Channels are created on first POST. In-memory only — fragments vanish when the server stops. Each channel keeps the most recent 500 fragments.

Channel paths support slash-separated namespaces, e.g. `cc/abc`. Namespaces can be backed by external suppliers via the registry (see below).

## API

- `POST /:channel/append` — body is Markdown
- `POST /:channel/status` — body is a label string ("thinking…", "building…", …); empty/`off`/`0` clears
- `POST /:channel/permission` — body is Markdown; long-polls until the browser POSTs `/decide/:id`. Response: `{id, decision:"allow"|"deny", message?}` or 408 timeout. Optional `?timeout=ms` (default 600000).
- `POST /:channel/decide/:id` — body `{decision:"allow"|"deny", message?}`. Browser sends this when the user clicks Allow/Deny.
- `GET /:channel` — JSON of fragments (HTML if browser)
- `GET /:channel/stream` — SSE stream of `{type:"fragment"|"status"|"decided", ...}` events (backlog + live)
- `GET /:channel/wait?since=<id>&timeout=<ms>` — long-poll for the next non-internal fragment (used by the MCP bridge).
- `GET /channels` — list with counts
- `GET /channels/stream` — SSE stream of channel meta events (created/updated)
- `GET /namespaces` — list registered namespace suppliers
- `GET /namespaces/stream` — SSE stream of supplier registry events

## Rendering

- Markdown via `marked`
- ` ```diff ` and ` ```diff:<lang> ` blocks: red/green per-line with word-level intra-line highlighting, supports `@@` hunk headers; with `:<lang>` the inner code is syntax-highlighted
- ` ```bash ` and other languages registered in `src/ui/App.tsx`: syntax-highlighted via highlight.js

## Claude Code hooks

Hooks are subcommands of the `jot` CLI:

| Hook | Subcommand | What it does |
|---|---|---|
| `UserPromptSubmit` | `jot claude hook user-prompt` | Posts the user prompt (truncated) and sets status to `thinking…` |
| `Stop` | `jot claude hook stop` | Posts the assistant's text reply, clears the status |
| `PreToolUse` | `jot claude hook tool` | Posts a Markdown fragment per tool call (Edit shows a real `diff -u`) |
| `Notification` | `jot claude hook notify` | Posts permission asks / idle alerts |
| `SessionStart` | `jot claude hook session-start` | Marks the channel with a session-start fragment |

Add to `~/.claude/settings.json` (after `npm link`):

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "jot claude hook user-prompt"   }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "jot claude hook stop"          }] }],
    "PreToolUse":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "jot claude hook tool"          }] }],
    "Notification":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "jot claude hook notify"        }] }],
    "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "jot claude hook session-start" }] }]
  }
}
```

Override the channel or label via env: `JOT_URL`, `JOT_CHANNEL`, `JOT_STATUS`.

The shared channel resolver maps each `session_id` to a jot channel. By default,
the first prompt of a session becomes a short channel slug; later hooks with
the same `session_id` reuse that channel. Set `JOT_CHANNEL` to force one fixed
channel across all agents. Mappings are persisted to
`~/.config/jot/sessions.json` (override with `JOT_SESSIONS_FILE`).

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

### Install

From inside Claude Code:

```
/plugin marketplace add moeki0/jot
/plugin install jot@jot
```

The plugin's `.mcp.json` is auto-loaded when the plugin is enabled — no manual `~/.claude/.mcp.json` edits needed. It runs `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --silent start`, which `bun install`s on first launch and then `bun server.ts`.

To start Claude Code with the jot channel bridge enabled (experimental `claude/channel` capability):

```bash
claude --dangerously-load-development-channels server:plugin:jot:jot
```

Each Claude session must use its own jot channel — otherwise multiple sessions share `claude-code` and cross-talk. Use `jot pair` to allocate a unique channel, open it in the browser, and inject it via `JOT_CHANNEL`:

```bash
export JOT_CHANNEL=$(jot pair) && claude --dangerously-load-development-channels server:plugin:jot:jot
```

`jot pair` prints the channel name to stdout and opens `http://localhost:7878/<channel>` in your browser. Both the hooks and the MCP server pick up `JOT_CHANNEL` from the environment.

### Claude bridge daemon

For session-less, GUI-driven flows (e.g. starting a Claude session from a phone-side browser), run the persistent bridge:

```bash
jot claude bridge                      # extra args after `bridge` are forwarded to `claude`
jot claude bridge --model opus
```

The bridge announces a `cc` namespace via the supplier registry, watches `/channels/stream` for new `cc/*` channels, and runs one persistent `claude -p` (stream-json) per channel — so sessions survive across user messages with no static configuration. The channels dropdown in the UI exposes a namespace selector for picking suppliers.

### Configuration

The MCP server reads:

- `JOT_URL` — base URL of the jot HTTP server (default `http://localhost:7878`)
- `JOT_CHANNEL` — channel name to bridge (default `claude-code`)

Make sure the jot server is running (`bun start`) on the same machine, on the URL the plugin points to.

