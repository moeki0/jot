import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_JOT_URL = "http://localhost:7878";

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "session";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part: any) => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return part.text ?? "";
    if (part?.type === "image") return "[image]";
    return part?.text ?? JSON.stringify(part);
  }).filter(Boolean).join("\n\n");
}

async function post(path: string, markdown: string) {
  const base = process.env.JOT_URL || DEFAULT_JOT_URL;
  try {
    await fetch(`${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`, {
      method: "POST",
      headers: { "content-type": "text/markdown; charset=utf-8" },
      body: markdown,
    });
  } catch {
    // jot is best-effort; keep pi sessions unaffected if the server is down.
  }
}

export default function (pi: ExtensionAPI) {
  let channel = process.env.JOT_CHANNEL || "";

  pi.on("session_start", async (_event, ctx) => {
    channel = channel || `pi/${slug(ctx.cwd || process.cwd())}`;
    await post(`${channel}/append?internal=1`, `> **pi session started**\n> cwd: \`${ctx.cwd || process.cwd()}\``);
    ctx.ui.setStatus("jot", `jot: ${channel}`);
  });

  pi.on("message_update", async (event: any) => {
    if (event.message?.role !== "assistant") return;
    const text = textFromContent(event.message.content).trim();
    if (text) await post(`${channel}/ephemeral?key=pi-assistant&animation=typing`, text.slice(0, 4000));
  });

  pi.on("message_end", async (event: any) => {
    const role = event.message?.role;
    if (!channel || (role !== "user" && role !== "assistant")) return;
    await post(`${channel}/ephemeral?key=pi-assistant`, "");
    const text = textFromContent(event.message.content).trim();
    if (!text) return;
    const title = role === "user" ? "User" : "Assistant";
    await post(`${channel}/append`, `## ${title}\n\n${text}`);
  });

  pi.on("tool_execution_start", async (event: any) => {
    if (!channel) return;
    await post(`${channel}/append?internal=1`, `> **Tool** ${event.toolName || "tool"}\n\n\`\`\`json\n${JSON.stringify(event.args ?? {}, null, 2)}\n\`\`\``);
  });
}
