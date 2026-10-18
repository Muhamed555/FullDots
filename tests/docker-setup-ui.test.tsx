import { describe, expect, it, vi } from 'vitest';
import { nextSteps } from '../src/client/computer-panel/DockerSetupCard';
import type { DockerSetupStatus } from '../src/shared/docker-setup-types';

// The API module reads the session token the moment it loads, and there is no browser here.
vi.hoisted(() => {
  Object.assign(globalThis, {
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
});

const status = (docker: DockerSetupStatus['docker']): DockerSetupStatus => ({
  enabled: true,
  platform: 'win32',
  docker,
  plans: [],
});

describe('Docker setup card', () => {
  it('offers the next step for what Docker is doing', () => {
    expect(nextSteps(status('unknown'))).toEqual(['check']);
    expect(nextSteps(status('not_installed'))[0]).toBe('install-docker');
    expect(nextSteps(status('stopped'))[0]).toBe('start-docker');
    expect(nextSteps(status('ready'))[0]).toBe('create-computers');
  });
});
