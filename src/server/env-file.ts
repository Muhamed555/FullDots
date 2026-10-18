// Reading and updating KEY=value lines of a `.env` file without disturbing the rest of it.

const escape = (key: string) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const linePattern = (key: string) =>
  new RegExp(`^[ \\t]*${escape(key)}[ \\t]*=(.*)$`, 'm');

/** The value of an active KEY=value line, unquoted; nothing when it is missing, empty or commented out. */
export function envValue(text: string, key: string): string | undefined {
  const raw = linePattern(key).exec(text)?.[1]?.trim();
  const unquoted = raw?.replace(/^(['"])(.*)\1$/, '$2');
  return unquoted || undefined;
}

/** Sets each key on its existing active line, or appends it. Comments and other lines are kept. */
export function upsertEnv(
  text: string,
  values: Record<string, string>,
): string {
  let next = text;
  for (const [key, value] of Object.entries(values)) {
    const line = linePattern(key);
    if (line.test(next)) next = next.replace(line, () => `${key}=${value}`);
    else next += `${next && !next.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
  }
  return next;
}
