import { expect, it } from 'vitest';
import { readIntegrationSettings } from '../src/server/limits.js';

it('reads the background concurrency and the daily token warning', () => {
  expect(readIntegrationSettings({})).toMatchObject({
    backgroundConcurrency: 2,
    dailyTokenWarn: 2_000_000,
  });
  expect(
    readIntegrationSettings({
      BACKGROUND_CONCURRENCY: '4',
      DOT_DAILY_TOKEN_WARN: '500000',
    }),
  ).toMatchObject({ backgroundConcurrency: 4, dailyTokenWarn: 500_000 });
});

it('refuses a concurrency outside 1 to 8', () => {
  expect(() =>
    readIntegrationSettings({ BACKGROUND_CONCURRENCY: '9' }),
  ).toThrow();
  expect(() =>
    readIntegrationSettings({ BACKGROUND_CONCURRENCY: '0' }),
  ).toThrow();
});
