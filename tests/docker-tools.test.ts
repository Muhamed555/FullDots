import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/server/approvals';
import { gateParse } from '../src/server/approval-gate';
import {
  DockerSetup,
  type DockerSetupOptions,
  type Runner,
} from '../src/server/docker-setup';
import { dockerPrompt, dockerTools } from '../src/server/docker-tools';

const ok: Runner = async () => ({ code: 0, output: 'secret terminal text' });
const makeSetup = (options: Partial<DockerSetupOptions> = {}) =>
  new DockerSetup({
    config: { baseUrl: 'http://x', voiceName: 'm' },
    enabled: true,
    platform: 'win32',
    cwd: mkdtempSync(join(tmpdir(), 'fulldots-docker-')),
    run: ok,
    sleep: async () => {},
    ...options,
  });
type Execute = (input: unknown) => Promise<Record<string, unknown>>;
const toolsOf = (setup: DockerSetup) =>
  Object.fromEntries(
    dockerTools(setup, () => {}).map((tool) => [
      tool.name,
      tool.execute as unknown as Execute,
    ]),
  );

describe('Docker tools for Dots', () => {
  it('always need the owner, whatever the approval mode', () => {
    for (const mode of ['off', 'sensitive', 'writes'] as const)
      expect(
        classify(
          { tool: 'docker_setup', args: { step: 'install-docker' } },
          mode,
        ).gated,
      ).toBe(true);
  });

  it('let the gate reject an unknown step before asking the owner', () => {
    expect(gateParse('docker_setup', { step: 'check' })).toEqual({
      step: 'check',
    });
    expect(() => gateParse('docker_setup', { step: 'rm -rf' })).toThrow();
  });

  it('answer in a sentence, without the command output', async () => {
    const setup = makeSetup();
    const { docker_setup, docker_status } = toolsOf(setup);
    const result = await docker_setup!({ step: 'check' });
    expect(result).toMatchObject({ state: 'done', docker: 'ready' });
    expect(JSON.stringify(result)).not.toContain('secret terminal text');
    expect(await docker_status!({})).toMatchObject({
      docker: 'ready',
      lastStep: { step: 'check', state: 'done' },
    });
  });

  it('never call an unchecked Docker missing, and say when computers already run', async () => {
    const running = makeSetup({
      config: {
        baseUrl: 'http://x',
        voiceName: 'm',
        computerSupervisorUrl: 'http://127.0.0.1:4312/',
        computerSupervisorToken: 'a'.repeat(24),
        computerToken: 'b'.repeat(24),
      },
      fetch: (async () => new Response('{}')) as typeof fetch,
    });
    const status = await toolsOf(running).docker_status!({});
    expect(status.computerService).toBe('reachable');
    expect(String(status.docker)).toMatch(/not checked yet/);
    expect(String(status.hint)).toMatch(/Do not set anything up/);
    expect(
      (await toolsOf(makeSetup()).docker_status!({})).computerService,
    ).toBe('not_set_up');
  });

  it('report a failed step instead of throwing', async () => {
    const setup = makeSetup({
      run: async (command) => ({
        code: command.args[0] === 'info' ? 1 : 0,
        output: '',
      }),
    });
    expect(
      await toolsOf(setup).docker_setup!({ step: 'create-computers' }),
    ).toMatchObject({ state: 'failed', docker: 'stopped' });
  });

  it('tell a Dot without computer tools to offer the setup', () => {
    expect(dockerPrompt(false)).toMatch(/no computer tools/);
    expect(dockerPrompt(true)).toMatch(/computer service is unavailable/);
  });
});
