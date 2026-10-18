import { describe, expect, it } from 'vitest';
import {
  desktopCommand,
  desktopInputs,
  frameCommand,
  parseWindows,
  shellQuote,
} from '../src/server/desktop-commands';
import { DesktopService } from '../src/server/desktop-service';
import { desktopRoutes } from '../src/server/desktop-routes';
import { desktopTools } from '../src/server/desktop-tools';
import { classify, categoriesOf } from '../src/server/approvals';
import type { ComputerService } from '../src/server/computer-service';

const WMCTRL = [
  '0x00c00003  0 0    0    1280 800  computer Untitled 1 - Mousepad',
  '0x01000004  0 40   60   640  400  computer xterm',
  '--active--',
  String(0x00c00003),
].join('\n');

/** A computer whose `exec` answers like OpenBot's and records each call. */
function fakeComputers(
  answer: Partial<{
    exitCode: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }> = {},
) {
  const calls: { command: string; actor: string; quiet?: boolean }[] = [];
  const result = {
    exitCode: 0,
    stdout: WMCTRL,
    stderr: '',
    truncated: false,
    timedOut: false,
    ...answer,
  };
  const computers = {
    action: async (
      _id: string,
      action: string,
      input: { command: string },
      actor: string,
    ) => {
      expect(action).toBe('exec');
      calls.push({ command: input.command, actor });
      return result;
    },
    quietExec: async (_id: string, input: { command: string }) => {
      calls.push({ command: input.command, actor: 'owner', quiet: true });
      return result;
    },
  } as unknown as ComputerService;
  return { computers, calls };
}

describe('desktop commands', () => {
  it('quote typed text so it can never become shell syntax', () => {
    expect(shellQuote(`it's $(rm -rf /)`)).toBe(`'it'\\''s $(rm -rf /)'`);
    const { command } = desktopCommand('type', {
      text: `a'; rm -rf / #`,
    });
    expect(command).toContain(`-- 'a'\\''; rm -rf / #'`);
  });

  it('refuse keys, windows, files and points outside what is allowed', () => {
    expect(() =>
      desktopInputs.key.parse({ keys: ['ctrl+s; reboot'] }),
    ).toThrow();
    expect(() => desktopInputs.focus.parse({ windowId: '1; ls' })).toThrow();
    expect(() =>
      desktopInputs.open.parse({ app: 'editor', file: '../../etc/passwd' }),
    ).toThrow();
    expect(() =>
      desktopInputs.open.parse({ app: 'editor', file: '/etc/hosts' }),
    ).toThrow();
    expect(() => desktopInputs.open.parse({ app: 'firefox' })).toThrow();
    expect(() => desktopInputs.click.parse({ x: 1280, y: 10 })).toThrow();
  });

  it('open apps detached, and list the windows after every action', () => {
    const { command } = desktopCommand('open', {
      app: 'editor',
      file: 'notes/today.txt',
    });
    expect(command).toMatch(
      /^setsid -f mousepad -- 'notes\/today\.txt' >\/dev\/null 2>&1/,
    );
    expect(command).toContain('wmctrl -lG');
    expect(command).toMatch(/exit \$status$/);
    expect(
      desktopCommand('click', { x: 5, y: 6, button: 'right', double: true })
        .command,
    ).toMatch(/^xdotool mousemove --sync 5 6 click --repeat 2 3;/);
  });

  it('read windows with titles that contain spaces, and the active one', () => {
    expect(parseWindows(WMCTRL)).toEqual([
      {
        id: '0x00c00003',
        title: 'Untitled 1 - Mousepad',
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
        active: true,
      },
      {
        id: '0x01000004',
        title: 'xterm',
        x: 40,
        y: 60,
        width: 640,
        height: 400,
        active: false,
      },
    ]);
    expect(parseWindows('')).toEqual([]);
  });

  it('take smaller pictures when the normal one does not fit', () => {
    expect(frameCommand().command).toContain('-resize 1024x640');
    expect(frameCommand(true).command).toContain('-resize 800x500');
  });
});

describe('desktop service', () => {
  it('returns the windows, and reports a failed action without throwing', async () => {
    const ok = fakeComputers();
    const service = new DesktopService(ok.computers);
    expect(
      (await service.act('dot', 'key', { keys: ['ctrl+s'] }, 'agent')).windows,
    ).toHaveLength(2);
    expect(ok.calls[0]).toMatchObject({ actor: 'agent' });

    const failed = new DesktopService(
      fakeComputers({ exitCode: 1, stderr: 'wmctrl: cannot find window' })
        .computers,
    );
    const state = await failed.act(
      'dot',
      'focus',
      { windowId: '0x1' },
      'agent',
    );
    expect(state.error).toMatch(/cannot find window/);
    expect(state.windows).toHaveLength(2);
  });

  it('says so when the computer has no desktop', async () => {
    const service = new DesktopService(
      fakeComputers({ exitCode: 127, stderr: 'sh: 1: wmctrl: not found' })
        .computers,
    );
    await expect(service.act('dot', 'windows', {}, 'agent')).rejects.toThrow(
      /no desktop/,
    );
  });

  it('takes frames quietly and falls back to a smaller picture', async () => {
    let calls = 0;
    const computers = {
      quietExec: async () => ({
        exitCode: 0,
        stdout: Buffer.from('jpeg').toString('base64'),
        stderr: '',
        truncated: calls++ === 0,
      }),
    } as unknown as ComputerService;
    const image = await new DesktopService(computers).frame('dot');
    expect(image.toString()).toBe('jpeg');
    expect(calls).toBe(2);
  });
});

describe('desktop routes and tools', () => {
  it('validate owner input before anything runs', async () => {
    const { computers, calls } = fakeComputers();
    const app = desktopRoutes(new DesktopService(computers));
    const post = (body: unknown) =>
      app.request('/dots/dot/computer/desktop/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ type: 'click', x: -1, y: 0 })).status).toBe(400);
    expect((await post({ type: 'shell', command: 'ls' })).status).toBe(400);
    expect(calls).toEqual([]);
    const ok = await post({ type: 'type', text: 'hello' });
    expect(ok.status).toBe(200);
    expect(calls[0]).toMatchObject({ actor: 'owner' });
  });

  it('serve frames as JPEG', async () => {
    const { computers } = fakeComputers({
      stdout: Buffer.from('jpeg').toString('base64'),
    });
    const response = await desktopRoutes(new DesktopService(computers)).request(
      '/dots/dot/computer/desktop/frame',
    );
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(await response.text()).toBe('jpeg');
  });

  it('give a Dot one tool per action that answers with an error, not a throw', async () => {
    const service = new DesktopService(
      fakeComputers({ exitCode: 127, stderr: 'xdotool: not found' }).computers,
    );
    const tools = desktopTools(
      service,
      'dot',
      () => {},
      new AbortController().signal,
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      'desktop_windows',
      'desktop_open',
      'desktop_focus',
      'desktop_type',
      'desktop_key',
      'desktop_click',
    ]);
    const type = tools.find((tool) => tool.name === 'desktop_type')!;
    const result = (await (
      type.execute as unknown as (input: unknown) => Promise<unknown>
    )({ text: 'hi' })) as { error?: string };
    expect(result.error).toMatch(/no desktop/);
  });

  it('are approved like shell commands', () => {
    const type = { tool: 'desktop_type', args: { text: 'echo hi' } };
    expect(classify(type, 'writes').gated).toBe(true);
    expect(classify(type, 'sensitive').gated).toBe(false);
    expect(
      classify(
        { tool: 'desktop_type', args: { text: 'rm -rf /workspace' } },
        'sensitive',
      ).gated,
    ).toBe(true);
    expect(categoriesOf(type)).toContain('run_shell');
    expect(
      classify({ tool: 'desktop_windows', args: {} }, 'writes').gated,
    ).toBe(false);
  });
});
