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
  'This computer has no desktop, because the desktop is turned off. The owner can turn it on in the Desktop tab of the Computer panel.';
/** The desktop is on, but the running computer was started from the image before it. */
const OLD_IMAGE =
  'The desktop is turned on, but this computer still runs the image from before. Ask the owner to stop and start the computer in its Computer panel (files are kept), then try again.';

export class DesktopService {
  /** One desktop action at a time per Dot: keys and typing must land in the order they were sent. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly computers: ComputerService,
    /** Whether the desktop is turned on (COMPUTER_DESKTOP), to explain a computer that lacks it. */
    private readonly desktopOn: () => boolean = () => false,
  ) {}

  private missing() {
    return new Error(this.desktopOn() ? OLD_IMAGE : NO_DESKTOP);
  }

  private inOrder<T>(dotId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(dotId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const settled = next.catch(() => {});
    this.queues.set(dotId, settled);
    void settled.then(() => {
      if (this.queues.get(dotId) === settled) this.queues.delete(dotId);
    });
    return next;
  }

  /** Runs one desktop action and returns the windows afterwards. Input is validated here. */
  act(
    dotId: string,
    action: DesktopAction,
    input: unknown,
    actor: 'owner' | 'agent',
    signal?: AbortSignal,
  ): Promise<DesktopState> {
    const parsed = desktopInputs[action].parse(input ?? {});
    return this.inOrder(dotId, () =>
      this.run(dotId, action, parsed, actor, signal),
    );
  }

  private async run(
    dotId: string,
    action: DesktopAction,
    parsed: unknown,
    actor: 'owner' | 'agent',
    signal?: AbortSignal,
  ): Promise<DesktopState> {
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
      throw this.missing();
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
        throw /not found/.test(result.stderr)
          ? this.missing()
          : new Error('The desktop picture could not be taken.');
      if (!result.truncated) return Buffer.from(result.stdout.trim(), 'base64');
    }
    throw new Error('The desktop picture is too large to send.');
  }
}
