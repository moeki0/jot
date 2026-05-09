// Persistent pi bridge: announces a `pi` namespace, watches `pi/*` channels,
// and runs one `pi --mode rpc` subprocess per channel. User messages from jot
// are sent to pi; pi streaming/events are posted back into the jot channel.

const SUPPLIER_ID = "pi";
const NAMESPACES = [{ prefix: "pi", label: "Pi" }];

const chPath = (ch: string) => ch.split("/").map(encodeURIComponent).join("/");

type Session = {
  proc: ReturnType<typeof Bun.spawn>;
  stdin: ReturnType<typeof Bun.spawn>["stdin"];
  nextId: number;
  lastAssistant: string;
};

function parseArgs(argv: string[]) {
  const opts: { piArgs: string[]; cwd?: string; bin?: string } = { piArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { opts.piArgs.push(...argv.slice(i + 1)); break; }
    if (a === "--cwd" && argv[i + 1]) { opts.cwd = argv[++i]; continue; }
    if (a.startsWith("--cwd=")) { opts.cwd = a.slice("--cwd=".length); continue; }
    if (a === "--bin" && argv[i + 1]) { opts.bin = argv[++i]; continue; }
    if (a.startsWith("--bin=")) { opts.bin = a.slice("--bin=".length); continue; }
    opts.piArgs.push(a);
  }
  return opts;
}

function truncate(s: string, n = 12000): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n\n… truncated (${s.length - n} chars omitted)`;
}

function fence(text: string, lang = "") {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function formatUsageFooter(u: any): string {
  if (!u || typeof u !== "object") return "";
  const tokens = typeof u.totalTokens === "number" ? u.totalTokens : (typeof u.input === "number" && typeof u.output === "number" ? u.input + u.output : null);
  const input = typeof u.input === "number" ? u.input : null;
  const output = typeof u.output === "number" ? u.output : null;
  const cacheRead = typeof u.cacheRead === "number" && u.cacheRead > 0 ? u.cacheRead : null;
  const cacheWrite = typeof u.cacheWrite === "number" && u.cacheWrite > 0 ? u.cacheWrite : null;
  const cost = typeof u.cost?.total === "number" ? u.cost.total : (typeof u.cost === "number" ? u.cost : null);
  if (tokens == null && cost == null) return "";
  const parts: string[] = [];
  if (tokens != null) parts.push(`${tokens.toLocaleString()} tokens`);
  if (cost != null) parts.push(`$${cost.toFixed(4)}`);
  const details: string[] = [];
  if (input != null) details.push(`in ${input.toLocaleString()}`);
  if (output != null) details.push(`out ${output.toLocaleString()}`);
  if (cacheRead != null) details.push(`cache read ${cacheRead.toLocaleString()}`);
  if (cacheWrite != null) details.push(`cache write ${cacheWrite.toLocaleString()}`);
  if (details.length) parts.push(`(${details.join(" · ")})`);
  if (!parts.length) return "";
  return `\n\n---\n_${parts.join(" · ")}_`;
}

function contentToMarkdown(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((block) => {
    if (block?.type === "text") return block.text ?? "";
    if (block?.type === "thinking") return `<details><summary>thinking</summary>\n\n${block.thinking ?? ""}\n\n</details>`;
    if (block?.type === "toolCall" || block?.type === "toolcall") {
      return `> **Tool call** \`${block.name ?? block.toolName ?? "tool"}\`\n\n${fence(JSON.stringify(block.arguments ?? block.args ?? {}, null, 2), "json")}`;
    }
    if (block?.type === "image") return `![image](data:${block.mimeType};base64,${block.data})`;
    return fence(JSON.stringify(block, null, 2), "json");
  }).filter(Boolean).join("\n\n");
}

async function writeJson(session: Session, obj: any) {
  (session.stdin as any).write(`${JSON.stringify(obj)}\n`);
  (session.stdin as any).flush?.();
}

export async function runPiBridge(extraArgs: string[]) {
  const flags = parseArgs(extraArgs);
  const JOT_URL = (process.env.JOT_URL ?? "http://localhost:7878").replace(/\/$/, "");
  const CWD = flags.cwd ?? process.env.PI_CWD ?? process.cwd();
  const PI_BIN = flags.bin ?? process.env.PI_BIN ?? "pi";

  const sessions = new Map<string, Session>();
  const watching = new Set<string>();

  async function appendToChannel(channel: string, markdown: string) {
    try {
      await fetch(`${JOT_URL}/${chPath(channel)}/append?internal=1`, { method: "POST", body: markdown });
    } catch (e) {
      console.error(`[${channel}] append failed:`, (e as Error).message);
    }
  }

  async function ephemeral(channel: string, key: string, markdown: string) {
    try {
      await fetch(`${JOT_URL}/${chPath(channel)}/ephemeral?key=${encodeURIComponent(key)}`, { method: "POST", body: markdown });
    } catch {}
  }

  function handleRpcEvent(channel: string, sess: Session, ev: any) {
    switch (ev?.type) {
      case "agent_start":
        void ephemeral(channel, "pi-status", "Thinking…");
        return;
      case "message_update": {
        if (ev.message?.role !== "assistant") return;
        const text = contentToMarkdown(ev.message.content).trim();
        if (text) void ephemeral(channel, "pi-assistant", truncate(text));
        return;
      }
      case "message_end": {
        if (ev.message?.role !== "assistant") return;
        void ephemeral(channel, "pi-assistant", "");
        const text = contentToMarkdown(ev.message.content).trim();
        sess.lastAssistant = text;
        if (text) {
          const footer = formatUsageFooter(ev.message.usage);
          void appendToChannel(channel, `## Assistant\n\n${truncate(text)}${footer}`);
        }
        return;
      }
      case "tool_execution_start":
        void appendToChannel(channel, `> **${ev.toolName}**\n\n${fence(JSON.stringify(ev.args ?? {}, null, 2), ev.toolName === "bash" ? "bash" : "json")}`);
        return;
      case "tool_execution_end":
        if (ev.isError) void appendToChannel(channel, `> **${ev.toolName} error**\n\n${fence(truncate(JSON.stringify(ev.result ?? {}, null, 2)), "json")}`);
        return;
      case "agent_end":
        void ephemeral(channel, "pi-status", "");
        return;
      case "extension_error":
        void appendToChannel(channel, `> pi extension error: ${ev.error ?? JSON.stringify(ev)}`);
        return;
    }
  }

  function spawnSession(channel: string): Session {
    const cur = sessions.get(channel);
    if (cur && !cur.proc.killed && cur.proc.exitCode === null) return cur;

    console.log(`[${channel}] spawning pi rpc`);
    const proc = Bun.spawn([PI_BIN, "--mode", "rpc", ...flags.piArgs], {
      cwd: CWD,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, JOT_CHANNEL: channel, PI_JOT: "0" },
    });
    const sess: Session = { proc, stdin: proc.stdin, nextId: 1, lastAssistant: "" };
    sessions.set(channel, sess);

    (async () => {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          let line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.trim()) continue;
          try { handleRpcEvent(channel, sess, JSON.parse(line)); }
          catch (e) { console.error(`[${channel}] bad rpc line:`, line.slice(0, 200)); }
        }
      }
    })().catch((e) => console.error(`[${channel}] stdout error:`, (e as Error).message));

    proc.exited.then((code) => {
      if (sessions.get(channel) === sess) sessions.delete(channel);
      void ephemeral(channel, "pi-status", "");
      console.log(`[${channel}] pi exited (${code})`);
    });

    void appendToChannel(channel, `> **pi session started**\n> cwd: \`${CWD}\``);
    return sess;
  }

  async function handleUserMessage(channel: string, text: string) {
    const sess = spawnSession(channel);
    try {
      await writeJson(sess, { id: `jot-${sess.nextId++}`, type: "prompt", message: text, streamingBehavior: "followUp" });
    } catch (e) {
      await appendToChannel(channel, `> pi prompt failed: ${(e as Error).message}`);
    }
  }

  async function watchChannel(channel: string) {
    if (watching.has(channel)) return;
    watching.add(channel);
    spawnSession(channel);
    console.log(`[${channel}] watching`);
    let since = 0;
    while (true) {
      let res: Response;
      try { res = await fetch(`${JOT_URL}/${chPath(channel)}/wait?since=${since}&timeout=600000`); }
      catch { await Bun.sleep(1000); continue; }
      if (res.status === 408) continue;
      if (!res.ok) { await Bun.sleep(1000); continue; }
      const { fragment } = await res.json() as { fragment: { id: number; markdown: string } };
      since = fragment.id;
      const text = (fragment.markdown ?? "").trim();
      if (text) void handleUserMessage(channel, text);
    }
  }

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

  await announce();
  setInterval(announce, 10_000);

  try {
    const list = await fetch(`${JOT_URL}/channels`).then((r) => r.json()) as { name: string }[];
    for (const c of list) if (c.name.startsWith("pi/")) void watchChannel(c.name);
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
            if (ev.type === "channel.created" && typeof ev.channel === "string" && ev.channel.startsWith("pi/")) void watchChannel(ev.channel);
          } catch {}
        }
      }
    } catch (e) {
      console.error("stream error:", (e as Error).message);
      await Bun.sleep(2000);
    }
  }
}
