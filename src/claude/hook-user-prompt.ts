import { append, ephemeral } from "./jot-client";
import { resolveChannel } from "./channel";
import { readJsonStdin } from "./io";

export async function hookUserPrompt() {
  const input = await readJsonStdin<{ session_id?: string; prompt?: string }>();
  const label = process.env.JOT_STATUS ?? "Thinking…";
  const channel = resolveChannel(input.session_id, input.prompt);

  await ephemeral(channel, label, "thinking");

  let prompt = input.prompt ?? "";
  if (prompt.includes('<channel source="jot"')) prompt = "";
  if (prompt.includes('<channel source="plugin:jot:jot"')) prompt = "";
  if (!prompt) return;

  const sourceMatch = prompt.match(/<channel source="([^"]+)"/);
  const source = sourceMatch?.[1];

  const lines = prompt.split("\n");
  let short = lines.slice(0, 2).join(" ").replace(/\s+$/, "");
  if (short.length > 200) {
    short = short.slice(0, 197) + "…";
  } else if (lines.length > 1 || prompt.length > short.length) {
    short = short + "…";
  }

  const md = source ? `**${source}** — ${short}` : `**You** — ${short}`;
  await append(channel, md);
}
