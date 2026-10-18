import { describe, expect, it, vi } from 'vitest';
import {
  nextSteps,
  stepLabel,
} from '../src/client/computer-panel/DockerSetupCard';
import { toScreenPoint } from '../src/client/computer-panel/DesktopStage';
import type { DockerPlan } from '../src/shared/docker-setup-types';

// The API module reads the session token the moment it loads, and there is no browser here.
vi.hoisted(() => {
  Object.assign(globalThis, {
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
});

const check: DockerPlan = {
  step: 'check',
  title: 'Check Docker',
  commands: [],
  note: '',
  supported: true,
};

describe('Docker setup card', () => {
  it('offers the next step for what Docker is doing', () => {
    expect(nextSteps('unknown')).toEqual(['check']);
    expect(nextSteps('not_installed')[0]).toBe('install-docker');
    expect(nextSteps('stopped')[0]).toBe('start-docker');
    expect(nextSteps('ready')[0]).toBe('create-computers');
  });
  it('calls a repeated check "Check again"', () => {
    expect(stepLabel('check', check, 'unknown')).toBe('Check Docker');
    expect(stepLabel('check', check, 'ready')).toBe('Check again');
  });
});

describe('Desktop view', () => {
  it('maps a click on the shown picture to the real screen', () => {
    expect(toScreenPoint(320, 200, 640, 400)).toEqual({ x: 640, y: 400 });
    expect(toScreenPoint(0, 0, 640, 400)).toEqual({ x: 0, y: 0 });
    expect(toScreenPoint(640, 400, 640, 400)).toEqual({ x: 1279, y: 799 });
  });
});
