#!/usr/bin/env bun
// Standalone bridge: announces a `cc` namespace to jot, watches for new
// channels under it, and runs ONE persistent `claude -p` per channel using
// stream-json input/output so the session is preserved across user messages.
//
// Output (assistant messages, session-start, etc.) is posted to the channel
// by the existing jot hooks — bridge does not parse stdout to avoid duplicates.
// Bridge only feeds user messages from the channel into the child's stdin.
//
// Run separately from the jot server:
//   bun scripts/claude-bridge.ts [extra claude flags...]
//
// Any args passed to this script are appended to the `claude` command line,
// e.g.  bun scripts/claude-bridge.ts --model opus --add-dir /some/path
//
// Env:
//   JOT_URL      base URL of jot server (default http://localhost:7878)
//   CLAUDE_CWD   working dir for spawned claude (default $PWD)

const JOT_URL = process.env.JOT_URL ?? "http://localhost:7878";
const SUPPLIER_ID = "claude";
const NAMESPACES = [{ prefix: "cc", label: "Claude Code" }];
const CWD = process.env.CLAUDE_CWD ?? process.cwd();
const EXTRA_ARGS = process.argv.slice(2);

const chPath = (ch: string) => ch.split("/").map(encodeURIComponent).join("/");

type Session = {
  proc: ReturnType<typeof Bun.spawn>;
  stdin: ReturnType<typeof Bun.spawn>["stdin"];
};
const sessions = new Map<string, Session>();
const watching = new Set<string>();

async function announce() {
  try {
    await fetch(`${JOT_URL}/suppliers/${SUPPLIER_ID}/announce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ namespaces: NAMESPACES }),
    });
  } catch (e) {
    console.error("announce failed:", (e as Error).message);
  }
}

function ensureSession(channel: string): Session {
  const cur = sessions.get(channel);
  if (cur && !cur.proc.killed && cur.proc.exitCode === null) return cur;
  console.log(`[${channel}] spawning claude`);
  const proc = Bun.spawn([
    "claude",
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-load-development-channels", "server:plugin:jot:jot",
    ...EXTRA_ARGS,
  ], {
    cwd: CWD,
    env: { ...process.env, JOT_CHANNEL: channel },
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  const sess: Session = { proc, stdin: proc.stdin };
  sessions.set(channel, sess);
  proc.exited.then(() => {
    if (sessions.get(channel) === sess) sessions.delete(channel);
    console.log(`[${channel}] claude exited`);
  });
  return sess;
}

async function sendUserMessage(channel: string, text: string) {
  const sess = ensureSession(channel);
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  }) + "\n";
  try {
    (sess.stdin as any).write(line);
    (sess.stdin as any).flush?.();
  } catch (e) {
    console.error(`[${channel}] write failed:`, (e as Error).message);
    sessions.delete(channel);
  }
}

async function watchChannel(channel: string) {
  if (watching.has(channel)) return;
  watching.add(channel);
  console.log(`[${channel}] watching`);
  let since = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(`${JOT_URL}/${chPath(channel)}/wait?since=${since}&timeout=600000`);
    } catch {
      await Bun.sleep(1000);
      continue;
    }
    if (res.status === 408) continue;
    if (!res.ok) { await Bun.sleep(1000); continue; }
    const { fragment } = await res.json() as { fragment: { id: number; markdown: string } };
    since = fragment.id;
    await sendUserMessage(channel, fragment.markdown);
  }
}

async function main() {
  await announce();
  setInterval(announce, 10_000);

  try {
    const list = await fetch(`${JOT_URL}/channels`).then((r) => r.json()) as { name: string }[];
    for (const c of list) if (c.name.startsWith("cc/")) watchChannel(c.name);
  } catch {}

  while (true) {
    try {
      const res = await fetch(`${JOT_URL}/channels/stream`);
      if (!res.ok || !res.body) throw new Error("bad stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.type === "channel.created" && typeof ev.channel === "string" && ev.channel.startsWith("cc/")) {
              watchChannel(ev.channel);
            }
          } catch {}
        }
      }
    } catch (e) {
      console.error("stream error:", (e as Error).message);
      await Bun.sleep(2000);
    }
  }
}

main();
