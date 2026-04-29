import { append, ephemeral } from "./jot-client";
import { resolveChannel } from "./channel";
import { readJsonStdin } from "./io";

export async function hookStop() {
  const input = await readJsonStdin<{ session_id?: string; last_assistant_message?: string }>();
  const channel = resolveChannel(input.session_id);
  await ephemeral(channel, "");
  const text = input.last_assistant_message;
  if (!text) return;
  await append(channel, text);
}
