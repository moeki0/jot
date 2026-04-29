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

const argv = process.argv.slice(2);
const cmd = argv[0];

switch (cmd) {
  case undefined:
  case "serve": {
    const port = Number(process.env.PORT ?? 7878);
    serve(port);
    console.log(`jot listening on http://localhost:${port}`);
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
  case "claude": {
    if (argv[1] !== "hook" || !argv[2]) {
      die("usage: jot claude hook <stop|user-prompt|tool|notify|session-start>");
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
    die(`jot: unknown command '${cmd}'`);
}
