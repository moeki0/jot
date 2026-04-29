#!/usr/bin/env bun
import { serve } from "./server";

const url = process.env.JOT_URL ?? "http://localhost:7878";

async function post(path: string, body?: string) {
  try {
    await fetch(`${url}${path}`, {
      method: "POST",
      body: body ?? "",
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // best-effort, silent
  }
}

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

const HELP = `jot — channel-based jot/notes server

Usage:
  jot [serve]                       Start the HTTP server (default port 7878, override with PORT)
  jot append <channel>              Append stdin as a message to <channel>
  jot ephemeral <channel> [key]     Post stdin as an ephemeral message; [key] replaces prior value
  jot signal <channel> <key>        Fire a signal on <channel>/<key>
  jot pair                          Allocate a unique channel, open it in the
                                    browser, and print the channel name to
                                    stdout (use with: export JOT_CHANNEL=$(jot pair))
  jot claude hook <name>            Run a Claude Code hook handler
                                    <name>: stop | user-prompt | tool | notify | session-start
  jot claude bridge [...args]       Start the persistent claude-bridge daemon.
                                    Announces a "cc" namespace and runs one
                                    persistent \`claude -p\` per cc/* channel.
                                    Extra args are forwarded to claude.
  jot help, -h, --help              Show this help
  jot version, -v, --version        Show version

Environment:
  PORT       Port for \`jot serve\` (default 7878)
  HOST       Bind address for \`jot serve\` (default Bun's: 0.0.0.0). Set to 127.0.0.1 to restrict to localhost.
  JOT_URL    Base URL for client commands (default http://localhost:7878)
`;

const argv = process.argv.slice(2);
const cmd = argv[0];

switch (cmd) {
  case "help":
  case "-h":
  case "--help": {
    console.log(HELP);
    break;
  }
  case "version":
  case "-v":
  case "--version": {
    const pkg = await import("../package.json");
    console.log((pkg as any).default?.version ?? (pkg as any).version);
    break;
  }
  case undefined:
  case "serve": {
    const port = Number(process.env.PORT ?? 7878);
    const host = process.env.HOST;
    serve(port, host);
    console.log(`jot listening on http://${host ?? "localhost"}:${port}`);
    break;
  }
  case "append": {
    const channel = argv[1];
    if (!channel) die("usage: jot append <channel>");
    await post(`/${channel}/append?internal=1`, await readStdin());
    break;
  }
  case "ephemeral": {
    const channel = argv[1];
    const key = argv[2];
    if (!channel) die("usage: jot ephemeral <channel> [key]");
    const q = key ? `?key=${encodeURIComponent(key)}` : "";
    await post(`/${channel}/ephemeral${q}`, await readStdin());
    break;
  }
  case "signal": {
    const channel = argv[1];
    const key = argv[2];
    if (!channel || !key) die("usage: jot signal <channel> <key>");
    await post(`/${channel}/signal?key=${encodeURIComponent(key)}`);
    break;
  }
  case "pair": {
    const rand = Math.random().toString(36).slice(2, 8);
    const channel = `cc-${rand}`;
    const target = `${url}/${channel}`;
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      Bun.spawn([opener, target], { stdout: "ignore", stderr: "ignore" });
    } catch {}
    console.log(channel);
    break;
  }
  case "claude": {
    if (argv[1] === "bridge") {
      const m = await import("./claude/bridge");
      await m.runBridge(argv.slice(2));
      break;
    }
    if (argv[1] !== "hook" || !argv[2]) {
      die("usage: jot claude (hook <name>|bridge [...args])");
    }
    const which = argv[2];
    switch (which) {
      case "stop":          { const m = await import("./claude/hook-stop");          await m.hookStop(); break; }
      case "user-prompt":   { const m = await import("./claude/hook-user-prompt");   await m.hookUserPrompt(); break; }
      case "tool":          { const m = await import("./claude/hook-tool");          await m.hookTool(); break; }
      case "notify":        { const m = await import("./claude/hook-notify");        await m.hookNotify(); break; }
      case "session-start": { const m = await import("./claude/hook-session-start"); await m.hookSessionStart(); break; }
      default: die(`jot claude hook: unknown '${which}'`);
    }
    break;
  }
  default:
    console.error(`jot: unknown command '${cmd}'\n`);
    console.error(HELP);
    process.exit(2);
}
