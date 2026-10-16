import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { computerTools } from '../src/server/computer-tools.js';
import { ComputerService } from '../src/server/computer-service.js';
import { LiveFrames } from '../src/server/computer-frames.js';
import {
  decodePng,
  encodeJpeg,
  keyframeFromPng,
  shrink,
} from '../src/server/frame-image.js';
import { defaultLimits, readLimits } from '../src/server/limits.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { computerFixture, page } from './fixtures/fake-computer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = Record<string, any>;
const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const closer of closers.splice(0)) closer.close();
});

/** A PNG of a colour pattern, written by hand. */
function png(width: number, height: number, alpha = false): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(0); // Unfiltered rows; the filters have a test of their own.
    for (let x = 0; x < width; x++) {
      rows.push((x * 7) & 0xff, (y * 5) & 0xff, ((x + y) * 3) & 0xff);
      if (alpha) rows.push(255);
    }
  }
  return pngFile(width, height, alpha ? 6 : 2, Buffer.from(rows));
}
function pngFile(
  width: number,
  height: number,
  colour: number,
  raw: Buffer,
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colour;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** The JPEG's frame size, from its SOF0 segment. */
function jpegSize(jpeg: Uint8Array) {
  for (let at = 2; at < jpeg.length;) {
    const marker = jpeg[at + 1];
    const length = (jpeg[at + 2] << 8) | jpeg[at + 3];
    if (marker === 0xc0)
      return {
        height: (jpeg[at + 5] << 8) | jpeg[at + 6],
        width: (jpeg[at + 7] << 8) | jpeg[at + 8],
      };
    at += 2 + length;
  }
  return undefined;
}

describe('keyframes', () => {
  it('decodes every PNG row filter', () => {
    // One RGB row per filter type over the same pixels: all must decode to the same colours.
    const first = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const pixels = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const raw: number[] = [0, ...first];
    let above = first;
    for (const filter of [0, 1, 2, 3, 4]) {
      raw.push(filter);
      pixels.forEach((value, x) => {
        const left = x >= 3 ? pixels[x - 3] : 0;
        const up = above[x];
        const corner = x >= 3 ? above[x - 3] : 0;
        const estimate = left + up - corner;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - corner);
        const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
        const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
        raw.push((value - predictor) & 0xff);
      });
      above = pixels;
    }
    const image = decodePng(pngFile(3, 6, 2, Buffer.from(raw)));
    expect(Array.from(image.data.subarray(0, 9))).toEqual(first);
    for (let row = 1; row < 6; row++)
      expect(Array.from(image.data.subarray(row * 9, row * 9 + 9))).toEqual(
        pixels,
      );
  });

  it('turns a full-size screenshot into a small JPEG at most 1024 wide', () => {
    const screenshot = png(1280, 800, true);
    const jpeg = keyframeFromPng(screenshot);
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(jpeg.at(-2)).toBe(0xff);
    expect(jpeg.at(-1)).toBe(0xd9);
    expect(jpegSize(jpeg)).toEqual({ width: 1024, height: 640 });
    // Smaller than the screenshot it came from.
    expect(jpeg.length).toBeLessThan(screenshot.length);
  });

  it('never scales up and keeps odd sizes', () => {
    const image = decodePng(png(37, 21));
    expect(shrink(image, 1024)).toBe(image);
    expect(jpegSize(encodeJpeg(image, 60))).toEqual({ width: 37, height: 21 });
  });

  it('refuses what is not a PNG it can read', () => {
    expect(() => decodePng(Buffer.from('not an image at all, really'))).toThrow(
      'Not a PNG',
    );
  });
});

describe('the replay limit', () => {
  it('defaults to 300 per Dot and reads COMPUTER_REPLAY_FRAMES', () => {
    expect(defaultLimits.computerReplayFrames).toBe(300);
    expect(
      readLimits({ COMPUTER_REPLAY_FRAMES: '25' }).computerReplayFrames,
    ).toBe(25);
    expect(
      readLimits({ COMPUTER_REPLAY_FRAMES: '0' }).computerReplayFrames,
    ).toBe(0);
    expect(() => readLimits({ COMPUTER_REPLAY_FRAMES: '-1' })).toThrow(
      'COMPUTER_REPLAY_FRAMES',
    );
  });
});

function setup(options: { cap?: number; threadId?: string | null } = {}) {
  const f = computerFixture();
  closers.push(f.workspace);
  const service = new ComputerService(
    f.workspace,
    {
      ...f.config,
      limits: { ...defaultLimits, computerReplayFrames: options.cap ?? 300 },
    },
    () => false,
    f.transport,
  );
  service.liveFrames = new LiveFrames();
  f.fake.screenshotBase64 = png(1280, 800).toString('base64');
  f.fake.pages['https://form.test/'] = page('Form', [
    { ref: 'e1', role: 'textbox', name: 'Name' },
  ]);
  const threadId = options.threadId === undefined ? 'thread' : options.threadId;
  const tools = computerTools(
    service,
    f.id,
    () => undefined,
    new AbortController().signal,
    { settleMs: 0, ...(threadId ? { threadId } : {}) },
  );
  let calls = 0;
  const run = async (name: string, input: unknown, toolCallId?: string) =>
    (await tools
      .find((tool) => tool.name === `computer_${name}`)!
      .execute?.(
        input as never,
        // The runtime's second argument; typed tools do not declare it.
        ...([
          { toolCallId: toolCallId ?? `call-${(calls += 1)}` },
        ] as unknown as []),
      )) as Result;
  return { ...f, service, run };
}

describe('recording browser steps', () => {
  it('keeps one step with a keyframe and adds no audit row of its own', async () => {
    const f = setup();
    const nav = await f.run(
      'navigate',
      { url: 'https://form.test/' },
      'tool-1',
    );
    await f.service.framesSettled();
    expect(nav.page.title).toBe('Form');
    // One action, one audit row: the screenshot ran inside the action's own session.
    expect(f.workspace.computers.audit(f.id)).toHaveLength(1);
    expect(f.workspace.computers.audit(f.id)[0]).toMatchObject({
      action: 'navigate',
      outcome: 'succeeded',
    });
    expect(f.fake.calls).toEqual(['navigate', 'snapshot', 'screenshot']);
    const steps = f.workspace.frames.steps(f.id, 'thread');
    expect(steps).toEqual([
      expect.objectContaining({
        toolCallId: 'tool-1',
        action: 'navigate',
        url: 'https://form.test/',
        title: 'Form',
        outcome: 'succeeded',
        hasFrame: true,
      }),
    ]);
    const jpeg = f.workspace.frames.frame(f.id, steps[0].id)!;
    expect(jpegSize(jpeg)).toEqual({ width: 1024, height: 640 });
  });

  it('records page-changing steps only, and failures without a picture', async () => {
    const f = setup();
    const nav = await f.run('navigate', { url: 'https://form.test/' });
    await f.run('read', {});
    await f.run('snapshot', {});
    // A ref from no snapshot of this turn: nothing is typed and the result is an error.
    const refused = await f.run('type', {
      ref: 'e9',
      snapshotId: 999,
      text: 'x',
    });
    expect(refused.error).toBeTruthy();
    // A key press the computer fails throws: the step is failed and has no picture.
    f.fake.failActions = 1;
    await expect(f.run('key', { key: 'Tab' })).rejects.toThrow(
      'The action failed.',
    );
    await f.service.framesSettled();
    const steps = f.workspace.frames.steps(f.id, 'thread');
    expect(steps.map((step) => [step.action, step.outcome])).toEqual([
      ['navigate', 'succeeded'],
      ['type', 'failed'],
      ['key', 'failed'],
    ]);
    expect(nav.page.snapshotId).toBeGreaterThan(0);
    expect(steps[2].hasFrame).toBe(false);
  });

  it('is on by default with Browser, and off when the owner turns it off', async () => {
    const f = setup();
    f.workspace.computers.patch(f.id, { replay: false });
    await f.run('navigate', { url: 'https://form.test/' });
    await f.service.framesSettled();
    expect(f.workspace.frames.count(f.id)).toBe(0);
    expect(f.fake.calls).not.toContain('screenshot');
    f.workspace.computers.patch(f.id, { replay: true });
    await f.run('scroll', { deltaY: 200 });
    await f.service.framesSettled();
    expect(f.workspace.frames.count(f.id)).toBe(1);
  });

  it('records nothing outside a conversation', async () => {
    const f = setup({ threadId: null });
    await f.run('navigate', { url: 'https://form.test/' });
    await f.service.framesSettled();
    expect(f.workspace.frames.count(f.id)).toBe(0);
    expect(f.fake.calls).not.toContain('screenshot');
  });

  it('keeps at most COMPUTER_REPLAY_FRAMES steps per Dot, dropping the oldest', async () => {
    const f = setup({ cap: 3 });
    for (let index = 0; index < 5; index++)
      await f.run('scroll', { deltaY: 100 }, `scroll-${index}`);
    await f.service.framesSettled();
    expect(
      f.workspace.frames.steps(f.id, 'thread').map((step) => step.toolCallId),
    ).toEqual(['scroll-2', 'scroll-3', 'scroll-4']);
    // Another Dot's steps are not pruned by this Dot's cap.
    const other = f.workspace.createDot(
      f.workspace.spaces()[0].id,
      'Other',
      '',
      false,
      false,
    );
    f.workspace.frames.add(
      {
        dotId: other.id,
        threadId: 'thread',
        toolCallId: 'x',
        action: 'navigate',
        url: '',
        title: '',
        outcome: 'succeeded',
      },
      3,
    );
    await f.run('scroll', { deltaY: 100 }, 'scroll-5');
    expect(f.workspace.frames.count(other.id)).toBe(1);
    expect(f.workspace.frames.count(f.id)).toBe(3);
  });

  it('reuses a live-screen frame from the last second instead of a screenshot', async () => {
    const f = setup();
    const frame = encodeJpeg(decodePng(png(64, 40)), 60);
    f.service.liveFrames.note(
      f.id,
      JSON.stringify({
        type: 'frame',
        data: frame.toString('base64'),
        width: 64,
        height: 40,
      }),
    );
    await f.run('navigate', { url: 'https://form.test/' });
    await f.service.framesSettled();
    expect(f.fake.calls).not.toContain('screenshot');
    const [step] = f.workspace.frames.steps(f.id, 'thread');
    expect(Buffer.from(f.workspace.frames.frame(f.id, step.id)!)).toEqual(
      frame,
    );
  });

  it('takes a screenshot when the live frame is older than a second', async () => {
    const f = setup();
    const frame = encodeJpeg(decodePng(png(64, 40)), 60);
    f.service.liveFrames.note(
      f.id,
      JSON.stringify({ type: 'frame', data: frame.toString('base64') }),
      Date.now() - 1500,
    );
    await f.run('navigate', { url: 'https://form.test/' });
    await f.service.framesSettled();
    expect(f.fake.calls).toContain('screenshot');
    const [step] = f.workspace.frames.steps(f.id, 'thread');
    expect(jpegSize(f.workspace.frames.frame(f.id, step.id)!)).toEqual({
      width: 1024,
      height: 640,
    });
  });

  it('keeps the step when its picture cannot be made, and says so only in the log', async () => {
    const f = setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    f.fake.screenshotBase64 = Buffer.from('not a png').toString('base64');
    await f.run('navigate', { url: 'https://form.test/' });
    await f.service.framesSettled();
    expect(f.workspace.frames.steps(f.id, 'thread')).toEqual([
      expect.objectContaining({ action: 'navigate', hasFrame: false }),
    ]);
    expect(log).toHaveBeenCalledWith(
      'Replay frame was not kept:',
      'Not a PNG image.',
    );
  });
});

describe('deleting', () => {
  const step = (dotId: string, threadId: string) => ({
    dotId,
    threadId,
    toolCallId: 'call',
    action: 'navigate',
    url: 'https://example.com/',
    title: 'Example',
    outcome: 'succeeded' as const,
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });

  it('removes a thread’s frames with the thread', () => {
    const workspace = new WorkspaceStore(':memory:', 'owner');
    closers.push(workspace);
    const dot = workspace.dots()[0];
    workspace.bindThread('gone', dot.id, 'Gone');
    workspace.bindThread('kept', dot.id, 'Kept');
    workspace.frames.add(step(dot.id, 'gone'), 300);
    workspace.frames.add(step(dot.id, 'kept'), 300);
    workspace.deleteThread('gone');
    expect(workspace.frames.steps(dot.id, 'gone')).toEqual([]);
    expect(workspace.frames.steps(dot.id, 'kept')).toHaveLength(1);
  });

  it('removes a Dot’s frames with the Dot', () => {
    const workspace = new WorkspaceStore(':memory:', 'owner');
    closers.push(workspace);
    const dot = workspace.dots()[0];
    workspace.frames.add(step(dot.id, 'thread'), 300);
    workspace.frames.add(step('other-dot', 'thread'), 300);
    workspace.frames.deleteDot(dot.id);
    expect(workspace.frames.count(dot.id)).toBe(0);
    expect(workspace.frames.count('other-dot')).toBe(1);
  });
});

describe('replay routes', () => {
  const config: PlatformConfig = {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
  };
  function routes() {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    closers.push(store, workspace);
    const platform = new Platform(store, workspace, config);
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      platform,
      ownerToken: 'owner-token-for-tests',
    });
    const dot = workspace.dots()[0];
    const other = workspace.createDot(
      workspace.spaces()[0].id,
      'Other',
      '',
      false,
      false,
    );
    workspace.computers.patch(dot.id, { enabled: true, browser: true });
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const mine = workspace.frames.add(
      {
        dotId: dot.id,
        threadId: 'thread',
        toolCallId: 'call-1',
        action: 'click',
        url: 'https://example.com/',
        title: 'Example',
        outcome: 'succeeded',
        jpeg,
      },
      300,
    );
    const theirs = workspace.frames.add(
      {
        dotId: other.id,
        threadId: 'thread',
        toolCallId: 'call-2',
        action: 'navigate',
        url: 'https://other.example/',
        title: 'Other',
        outcome: 'succeeded',
        jpeg,
      },
      300,
    );
    const get = (path: string, token = 'owner-token-for-tests') =>
      app.request(path, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    return { app, workspace, dot, other, mine, theirs, jpeg, get };
  }

  it('are owner-only', async () => {
    const r = routes();
    expect(
      (await r.get(`/api/dots/${r.dot.id}/computer/replay?threadId=thread`, ''))
        .status,
    ).toBe(401);
    expect(
      (await r.get(`/api/dots/${r.dot.id}/computer/frames/${r.mine}`, ''))
        .status,
    ).toBe(401);
  });

  it('lists a thread’s steps for one Dot only', async () => {
    const r = routes();
    const response = await r.get(
      `/api/dots/${r.dot.id}/computer/replay?threadId=thread`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      replay: true,
      steps: [
        {
          id: r.mine,
          toolCallId: 'call-1',
          createdAt: expect.any(Number),
          action: 'click',
          url: 'https://example.com/',
          title: 'Example',
          outcome: 'succeeded',
          hasFrame: true,
        },
      ],
    });
    expect((await r.get(`/api/dots/${r.dot.id}/computer/replay`)).status).toBe(
      400,
    );
    expect(
      (await r.get('/api/dots/nobody/computer/replay?threadId=thread')).status,
    ).toBe(404);
  });

  it('serves a frame as a JPEG, and 404s for another Dot’s frame', async () => {
    const r = routes();
    const response = await r.get(
      `/api/dots/${r.dot.id}/computer/frames/${r.mine}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(r.jpeg);
    expect(
      (await r.get(`/api/dots/${r.dot.id}/computer/frames/${r.theirs}`)).status,
    ).toBe(404);
    expect(
      (await r.get(`/api/dots/${r.dot.id}/computer/frames/missing`)).status,
    ).toBe(404);
  });
});
