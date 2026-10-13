import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOT_PALETTES } from '../src/client/DotCharacter';
import { DOT_COLORS } from '../src/shared/types';

const css = readFileSync(
  join(__dirname, '..', 'src', 'client', 'tokens.css'),
  'utf8',
);

describe('tokens.css', () => {
  it('defines the core tokens and motion tokens', () => {
    for (const token of [
      '--ink',
      '--muted',
      '--line',
      '--surface',
      '--surface-raised',
      '--accent',
      '--success',
      '--warning',
      '--danger',
      '--radius-md',
      '--space-3',
      '--shadow-md',
      '--text-md',
      '--ease-spring',
      '--ease-out',
      '--dur-fast',
      '--dur-med',
      '--dur-slow',
    ])
      expect(css).toContain(`${token}:`);
  });

  it('keeps the per-Dot palette tokens in step with DOT_PALETTES', () => {
    expect(Object.keys(DOT_PALETTES)).toEqual([...DOT_COLORS]);
    for (const color of DOT_COLORS) {
      const palette = DOT_PALETTES[color];
      for (const part of ['base', 'light', 'dark', 'cheek'] as const)
        expect(css).toContain(`--dot-${color}-${part}: ${palette[part]};`);
    }
  });
});
