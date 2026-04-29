import { append } from "./jot-client";
import { resolveChannel } from "./channel";
import { readJsonStdin } from "./io";

export async function hookSessionStart() {
  const input = await readJsonStdin<{ session_id?: string }>();
  const channel = resolveChannel(input.session_id);
  await append(channel, "— session started —");
}
