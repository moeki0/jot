export async function readJsonStdin<T = any>(): Promise<T> {
  const text = await Bun.stdin.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text);
}

export function writeStdout(s: string) {
  Bun.write(Bun.stdout, s.endsWith("\n") ? s : s + "\n");
}
