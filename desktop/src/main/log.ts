// One log file for the shell and the server it runs, plus the recent lines kept in memory for the
// boot screen to show when the workspace could not start.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const TAIL_LINES = 80;

export interface Log {
  readonly file: string;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
  /** Output of the server process, written as it arrives. */
  server(chunk: Buffer | string): void;
  /** The most recent server lines. */
  tail(): string;
}

export function createLog(file: string): Log {
  let usable = true;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // One previous file is kept; a log is for the last few runs, not an archive.
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES)
      renameSync(file, `${file}.old`);
  } catch {
    usable = false;
  }
  const recent: string[] = [];
  const write = (text: string) => {
    if (!usable) return;
    try {
      appendFileSync(file, text);
    } catch {
      // A full disk or a locked file must not take the app down with it.
      usable = false;
    }
  };
  const line = (level: string, message: string) =>
    write(`${new Date().toISOString()} [${level}] ${message}\n`);
  return {
    file,
    info: (message) => line('info', message),
    warn: (message) => line('warn', message),
    error: (message, error) =>
      line(
        'error',
        error === undefined
          ? message
          : `${message}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      ),
    server(chunk) {
      const text = chunk.toString();
      write(text.endsWith('\n') ? text : `${text}\n`);
      for (const part of text.split(/\r?\n/))
        if (part.trim()) recent.push(part);
      if (recent.length > TAIL_LINES)
        recent.splice(0, recent.length - TAIL_LINES);
    },
    tail: () => recent.join('\n'),
  };
}
