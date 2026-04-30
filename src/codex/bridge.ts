// Persistent codex bridge: announces a `cx` namespace, watches `cx/*` channels,
// runs a single shared `codex app-server` and maintains one Thread per channel.
//
// User messages → turn/start. Agent text and approval prompts are posted back
// into the channel via the jot HTTP API.

import { AppServerClient, type IncomingServerRequest, type Notification } from "./app-server-client";

const SUPPLIER_ID = "codex";
const NAMESPACES = [{ prefix: "cx", label: "Codex" }];

const chPath = (ch: string) => ch.split("/").map(encodeURIComponent).join("/");

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `… (+${s.length - n} chars)`;
}

function renderItem(item: any): string | null {
  switch (item?.type) {
    case "agentMessage":
      return typeof item.text === "string" ? item.text : null;
    case "reasoning":
      return null; // skip reasoning summaries by default
    case "commandExecution": {
      const cmd = item.command ?? item.parsedCommand?.text ?? "(command)";
      const status = item.status ?? item.exitCode != null ? `exit=${item.exitCode}` : "";
      const out = item.aggregatedOutput ?? item.output ?? item.stdout ?? "";
      const head = `\`\`\`sh\n$ ${cmd}\n\`\`\``;
      const tail = out ? `\n\n\`\`\`\n${truncate(String(out), 1200)}\n\`\`\`` : "";
      const meta = status ? `\n\n_${status}_` : "";
      return `🛠 commandExecution${meta}\n\n${head}${tail}`;
    }
    case "fileChange": {
      const path = item.path ?? item.filePath ?? "(file)";
      return `📝 fileChange: \`${path}\``;
    }
    case "mcpToolCall": {
      const name = item.toolName ?? item.name ?? "(tool)";
      return `🔧 mcp tool: \`${name}\``;
    }
    case "webSearch": {
      const q = item.query ?? "(query)";
      return `🔎 web search: ${q}`;
    }
    case "todoList":
    case "plan":
      return null;
    default:
      return null;
  }
}

type ChannelState = {
  threadId: string | null;
  starting: Promise<string> | null;
  // current turn id, if any
  turnId: string | null;
};

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) { opts[a.slice(2)] = v; i++; }
      else opts[a.slice(2)] = "true";
    }
  }
  return opts;
}

export async function runCodexBridge(extraArgs: string[]) {
  const flags = parseArgs(extraArgs);
  const JOT_URL = process.env.JOT_URL ?? "http://localhost:7878";
  const CWD = flags.cwd ?? process.env.CODEX_CWD ?? process.cwd();
  const APPROVAL_POLICY = flags.approval ?? process.env.CODEX_APPROVAL_POLICY ?? "on-request";
  const SANDBOX = flags.sandbox ?? process.env.CODEX_SANDBOX ?? "workspace-write";
  const MODEL = flags.model ?? process.env.CODEX_MODEL ?? null;
  const REASONING_EFFORT = flags["reasoning-effort"] ?? process.env.CODEX_REASONING_EFFORT ?? null;

  const channels = new Map<string, ChannelState>();
  const watching = new Set<string>();

  const client = new AppServerClient({ cwd: CWD });
  await client.initialize({ name: "jot", title: "jot codex bridge", version: "0.1.0" });

  // helpers
  async function appendToChannel(channel: string, markdown: string) {
    try {
      await fetch(`${JOT_URL}/${chPath(channel)}/append?internal=1`, {
        method: "POST",
        body: markdown,
      });
    } catch (e) {
      console.error(`[${channel}] append failed:`, (e as Error).message);
    }
  }

  function channelForThread(threadId: string): string | null {
    for (const [name, st] of channels) if (st.threadId === threadId) return name;
    return null;
  }

  // notification dispatch — route by threadId in params
  client.onNotification((n: Notification) => {
    const tid = n.params?.threadId;
    if (!tid) return; // ignore global notifications for now
    const channel = channelForThread(tid);
    if (!channel) return;

    switch (n.method) {
      case "item/completed": {
        const item = n.params?.item;
        if (!item) return;
        const md = renderItem(item);
        if (md) appendToChannel(channel, md);
        return;
      }
      case "thread/tokenUsage/updated": {
        // could surface this; skipped for the minimal cut
        return;
      }
      case "turn/started": {
        const st = channels.get(channel);
        if (st) st.turnId = n.params?.turnId ?? null;
        return;
      }
      case "turn/completed": {
        const st = channels.get(channel);
        if (st) st.turnId = null;
        return;
      }
      case "error": {
        appendToChannel(channel, `> codex error: \`${JSON.stringify(n.params).slice(0, 400)}\``);
        return;
      }
    }
  });

  // server-initiated requests — primarily approvals.
  // We push a fragment to the channel via POST /:channel/permission, which
  // long-polls until the user clicks a button. The button value drives the
  // RPC response back to codex.
  client.onServerRequest(async (req: IncomingServerRequest) => {
    const tid = req.params?.threadId;
    const channel = tid ? channelForThread(tid) : null;
    if (!channel) {
      try { req.respond({ decision: "decline" }); } catch {}
      return;
    }

    let summary: string;
    let kind: "v2" | "legacy" | "permissions";
    switch (req.method) {
      case "item/commandExecution/requestApproval":
        kind = "v2";
        summary = `\`${req.params.command ?? "(unknown command)"}\``;
        if (req.params.reason) summary += `\n\n> ${req.params.reason}`;
        break;
      case "item/fileChange/requestApproval":
        kind = "v2";
        summary = `file change${req.params.reason ? `\n\n> ${req.params.reason}` : ""}`;
        break;
      case "item/permissions/requestApproval":
        kind = "permissions";
        summary = `permission change${req.params.reason ? `\n\n> ${req.params.reason}` : ""}`;
        break;
      case "execCommandApproval":
        kind = "legacy";
        summary = `\`${req.params.command ?? ""}\``;
        break;
      case "applyPatchApproval":
        kind = "legacy";
        summary = `apply patch`;
        break;
      default:
        try { req.respond({ decision: "decline" }); } catch {}
        try { req.error(-32601, `unhandled: ${req.method}`); } catch {}
        return;
    }

    const md = `**Codexが承認を要求しています**\n\n${summary}`;
    let value = "deny";
    try {
      const res = await fetch(
        `${JOT_URL}/${chPath(channel)}/permission?internal=1&timeout=600000`,
        { method: "POST", body: md },
      );
      if (res.ok) {
        const j = (await res.json()) as { value?: string };
        if (j.value) value = j.value;
      } else {
        // 408 timeout etc — treat as deny
        value = "deny";
      }
    } catch (e) {
      console.error(`[${channel}] permission failed:`, (e as Error).message);
      value = "deny";
    }

    const approve = value === "allow" || value === "accept";
    try {
      if (kind === "legacy") {
        req.respond({ decision: approve ? "approved" : "denied" });
      } else if (kind === "permissions") {
        if (approve) {
          // Grant the permissions the agent requested for the rest of the thread.
          req.respond({
            permissions: req.params?.permissions ?? {},
            scope: "thread",
          });
        } else {
          // Permissions decline shape: spec is unclear; respond with empty grant + thread scope.
          req.respond({ permissions: {}, scope: "thread" });
        }
      } else {
        req.respond({ decision: approve ? "accept" : "decline" });
      }
    } catch (e) {
      console.error(`[${channel}] respond failed:`, (e as Error).message);
    }
  });

  async function ensureThread(channel: string): Promise<string> {
    const st = channels.get(channel)!;
    if (st.threadId) return st.threadId;
    if (st.starting) return st.starting;
    st.starting = (async () => {
      const params: any = {
        approvalPolicy: APPROVAL_POLICY,
        sandbox: SANDBOX,
        cwd: CWD,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      };
      if (MODEL) params.model = MODEL;
      if (REASONING_EFFORT) params.config = { ...(params.config ?? {}), model_reasoning_effort: REASONING_EFFORT };
      const res: any = await client.request("thread/start", params);
      const id = res.thread?.id ?? res.threadId;
      if (!id) throw new Error("thread/start returned no id");
      st.threadId = id;
      console.log(`[${channel}] thread ${id}`);
      return id;
    })();
    try { return await st.starting; } finally { st.starting = null; }
  }

  async function handleUserMessage(channel: string, text: string) {
    const threadId = await ensureThread(channel);
    try {
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
    } catch (e) {
      await appendToChannel(channel, `> turn/start failed: ${(e as Error).message}`);
    }
  }

  async function watchChannel(channel: string) {
    if (watching.has(channel)) return;
    watching.add(channel);
    if (!channels.has(channel)) {
      channels.set(channel, { threadId: null, starting: null, turnId: null });
    }
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
      handleUserMessage(channel, fragment.markdown);
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
    for (const c of list) if (c.name.startsWith("cx/")) watchChannel(c.name);
  } catch {}

  // discover new channels
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
            if (ev.type === "channel.created" && typeof ev.channel === "string" && ev.channel.startsWith("cx/")) {
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
