// The shell's own small settings file: window position, the port, the last theme.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ShellTheme } from '../ipc';
import type { SavedWindow } from './window-state';

export interface Settings {
  window?: SavedWindow;
  /** The port the workspace last ran on, kept so the page's saved state stays with its origin. */
  port?: number;
  theme?: ShellTheme;
  themeColor?: string;
  /** Closing the window keeps FullDots running in the tray. Unset means the platform default. */
  keepRunning?: boolean;
  backgroundHintShown?: boolean;
}

export class SettingsStore {
  private current: Settings;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly file: string,
    private readonly report: (message: string) => void = () => {},
  ) {
    this.current = this.read();
  }

  get value(): Readonly<Settings> {
    return this.current;
  }

  update(patch: Partial<Settings>): void {
    this.current = { ...this.current, ...patch };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  /** Writes now. A temporary file and a rename, so a crash never leaves half a file. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.current, null, 2)}\n`);
      renameSync(temporary, this.file);
    } catch (error) {
      this.report(
        `Could not save settings: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private read(): Settings {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Settings) : {};
    } catch {
      // Missing on first run; a damaged file starts over rather than blocking the app.
      return {};
    }
  }
}
