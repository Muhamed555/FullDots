import { expect, it } from 'vitest';
import {
  NO_TIME_LIMIT_MS,
  readIntegrationSettings,
  readLimits,
} from '../src/server/limits.js';

it('reads the background concurrency (4 by default) and the daily token warning', () => {
  expect(readIntegrationSettings({})).toMatchObject({
    backgroundConcurrency: 4,
    dailyTokenWarn: 2_000_000,
  });
  expect(
    readIntegrationSettings({
      BACKGROUND_CONCURRENCY: '1',
      DOT_DAILY_TOKEN_WARN: '500000',
    }),
  ).toMatchObject({ backgroundConcurrency: 1, dailyTokenWarn: 500_000 });
});

it('refuses a concurrency outside 1 to 8', () => {
  expect(() =>
    readIntegrationSettings({ BACKGROUND_CONCURRENCY: '9' }),
  ).toThrow();
  expect(() =>
    readIntegrationSettings({ BACKGROUND_CONCURRENCY: '0' }),
  ).toThrow();
});

it('reads the team depth, 2 by default and at most 5', () => {
  expect(readIntegrationSettings({}).teamMaxDepth).toBe(2);
  expect(readIntegrationSettings({ TEAM_MAX_DEPTH: '3' }).teamMaxDepth).toBe(3);
  expect(() => readIntegrationSettings({ TEAM_MAX_DEPTH: '6' })).toThrow();
});

it('reads the delegation timeout and the result batch window', () => {
  expect(readLimits({}).delegationTimeoutMs).toBe(300_000);
  expect(readLimits({ DELEGATION_TIMEOUT: '600' }).delegationTimeoutMs).toBe(
    600_000,
  );
  expect(readLimits({ DELEGATION_TIMEOUT: '0' }).delegationTimeoutMs).toBe(
    NO_TIME_LIMIT_MS,
  );
  expect(() => readLimits({ DELEGATION_TIMEOUT: '7201' })).toThrow(
    'DELEGATION_TIMEOUT',
  );
  expect(readIntegrationSettings({}).teamResultBatchMs).toBe(1500);
  expect(
    readIntegrationSettings({ TEAM_RESULT_BATCH_MS: '0' }).teamResultBatchMs,
  ).toBe(0);
  expect(() =>
    readIntegrationSettings({ TEAM_RESULT_BATCH_MS: '60001' }),
  ).toThrow();
});
