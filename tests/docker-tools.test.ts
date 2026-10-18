import { describe, expect, it } from 'vitest';
import { classify } from '../src/server/approvals';
import { DockerSetup, type Runner } from '../src/server/docker-setup';
import { dockerTools } from '../src/server/docker-tools';

const run: Runner = async () => ({ code: 0, output: 'secret terminal text' });
const setup = () =>
  new DockerSetup({
    config: { baseUrl: 'http://x', voiceName: 'm' },
    enabled: true,
    platform: 'win32',
    run,
    sleep: async () => {},
  });
type Exec = (input: unknown) => Promise<Record<string, unknown>>;
const tools = (docker: DockerSetup) =>
  Object.fromEntries(
    dockerTools(docker, () => {}).map((tool) => [
      tool.name,
      tool.execute as unknown as Exec,
    ]),
  );

describe('Docker tools for Dots', () => {
  it('always need the owner, whatever the approval mode', () => {
    for (const mode of ['off', 'sensitive', 'writes'] as const) {
      const result = classify(
        { tool: 'docker_setup', args: { step: 'install-docker' } },
        mode,
      );
      expect(result.gated).toBe(true);
    }
  });

  it('runs a step and answers in one sentence without the command output', async () => {
    const docker = setup();
    const { docker_setup, docker_status } = tools(docker);
    const result = await docker_setup!({ step: 'check' });
    expect(result).toMatchObject({ state: 'done', docker: 'ready' });
    expect(JSON.stringify(result)).not.toContain('secret terminal text');
    expect(await docker_status!({})).toMatchObject({
      docker: 'ready',
      lastStep: 'check',
    });
  });

  it('never reports an unchecked Docker as missing and says when computers already run', async () => {
    const running = new DockerSetup({
      config: {
        baseUrl: 'http://x',
        voiceName: 'm',
        computerSupervisorUrl: 'http://127.0.0.1:4312/',
        computerSupervisorToken: 'a'.repeat(24),
        computerToken: 'b'.repeat(24),
      },
      enabled: true,
      platform: 'win32',
      run,
      fetch: (async () => new Response('{}')) as typeof fetch,
    });
    const status = await tools(running).docker_status!({});
    expect(status.computerService).toBe('reachable');
    expect(String(status.docker)).toMatch(/not checked yet/);
    expect(String(status.hint)).toMatch(/Do not set anything up/);
    const bare = await tools(setup()).docker_status!({});
    expect(bare.computerService).toBe('not_set_up');
  });

  it('reports a refused step instead of throwing', async () => {
    const docker = setup();
    const { docker_setup } = tools(docker);
    expect(await docker_setup!({ step: 'create-computers' })).toMatchObject({
      state: 'failed',
    });
    expect(docker.commandsFor('check')).toEqual([
      'docker --version',
      'docker info --format "{{.ServerVersion}}"',
    ]);
  });
});
