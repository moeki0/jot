import { append, signal } from "./jot-client";
import { resolveChannel } from "./channel";
import { readJsonStdin } from "./io";

export async function hookNotify() {
  const input = await readJsonStdin<{
    session_id?: string;
    message?: string;
    tool_name?: string;
    tool_input?: any;
  }>();
  const msg = input.message;
  if (!msg) return;

  let extra = "";
  if (input.tool_name) {
    switch (input.tool_name) {
      case "Bash":
        extra = `\n\n\`\`\`bash\n${input.tool_input?.command ?? ""}\n\`\`\``;
        break;
      case "Edit":
      case "Write":
      case "Read":
        extra = ` \`${input.tool_input?.file_path ?? ""}\``;
        break;
      default:
        extra = ` (${input.tool_name})`;
    }
  }

  const md = `> ⚠ ${msg}${extra}`;
  const channel = resolveChannel(input.session_id);

  if (input.session_id) {
    const key = ("cc:" + input.session_id).replace(/[^A-Za-z0-9:_.-]/g, "_");
    const resp = await signal(channel, key, md);
    if (resp?.matched) return;
  }
  await append(channel, md);
}
