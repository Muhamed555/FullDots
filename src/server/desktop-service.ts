// Desktop control for a Dot's computer: list, open and focus windows, type, press keys and click,
// plus pictures of the whole screen for the Computer panel. Everything runs through the computer's
// `exec` call, so it needs the Dot's shell permission, stops while the owner holds the computer, and
// appears in Activity (except the panel's frames, see `ComputerService.quietExec`).
import type { ComputerService } from './computer-service.js';
import {
  PROBE_COMMAND,
  desktopCommand,
  desktopInputs,
  frameCommand,
  parseWindows,
  type DesktopAction,
} from './desktop-commands.js';
import type {
  DesktopOwnerInput,
  DesktopState,
} from '../shared/desktop-types.js';

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

const asShellResult = (value: unknown): ShellResult => {
  const raw = (value ?? {}) as Partial<ShellResult>;
  return {
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : 1,
    stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
    stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    truncated: raw.truncated === true,
    timedOut: raw.timedOut === true,
  };
};

const NO_DESKTOP =
  'This computer has no desktop. Rebuild it with the desktop image (COMPUTER_DESKTOP); see docs/COMPUTERS.md.';

export class DesktopService {
  constructor(private readonly computers: ComputerService) {}

  /** Runs one desktop action and returns the windows afterwards. Input is validated here. */
  async act(
    dotId: string,
    action: DesktopAction,
    input: unknown,
    actor: 'owner' | 'agent',
    signal?: AbortSignal,
  ): Promise<DesktopState> {
    const parsed = desktopInputs[action].parse(input ?? {});
    const result = asShellResult(
      await this.computers.action(
        dotId,
        'exec',
        desktopCommand(action, parsed as never),
        actor,
        signal,
      ),
    );
    if (
      /command not found|wmctrl: not found|xdotool: not found/.test(
        result.stderr,
      )
    )
      throw new Error(NO_DESKTOP);
    const windows = parseWindows(result.stdout);
    if (result.exitCode === 0) return { windows };
    const detail = result.timedOut
      ? 'it timed out'
      : result.stderr.trim().split('\n').at(-1) || `exit ${result.exitCode}`;
    return { windows, error: `The ${action} action failed: ${detail}.` };
  }

  /** The owner's input from the Desktop view, as the same audited actions a Dot uses. */
  owner(
    dotId: string,
    input: DesktopOwnerInput,
    signal?: AbortSignal,
  ): Promise<DesktopState> {
    switch (input.type) {
      case 'click':
        return this.act(
          dotId,
          'click',
          { x: input.x, y: input.y, double: !!input.double },
          'owner',
          signal,
        );
      case 'type':
        return this.act(dotId, 'type', { text: input.text }, 'owner', signal);
      case 'key':
        return this.act(dotId, 'key', { keys: input.keys }, 'owner', signal);
    }
  }

  /** Whether the computer runs a desktop. Recorded once in Activity, when the Desktop view opens. */
  async available(dotId: string, signal?: AbortSignal): Promise<boolean> {
    const result = asShellResult(
      await this.computers.action(
        dotId,
        'exec',
        { command: PROBE_COMMAND, timeoutMs: 5000 },
        'owner',
        signal,
      ),
    );
    return result.exitCode === 0;
  }

  /** A JPEG of the whole screen for the owner. Not recorded per frame. */
  async frame(dotId: string, signal?: AbortSignal): Promise<Buffer> {
    for (const small of [false, true]) {
      const result = asShellResult(
        await this.computers.quietExec(dotId, frameCommand(small), signal),
      );
      if (result.exitCode !== 0)
        throw new Error(
          /not found/.test(result.stderr)
            ? NO_DESKTOP
            : 'The desktop picture could not be taken.',
        );
      if (!result.truncated) return Buffer.from(result.stdout.trim(), 'base64');
    }
    throw new Error('The desktop picture is too large to send.');
  }
}
