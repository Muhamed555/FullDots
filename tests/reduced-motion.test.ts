import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLIENT = join(__dirname, '..', 'src', 'client');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith('.css') ? [path] : [];
  });
}

describe('reduced motion', () => {
  const animated = cssFiles(CLIENT).filter((file) =>
    readFileSync(file, 'utf8').includes('@keyframes'),
  );

  it('finds the stylesheets that animate', () => {
    expect(animated.length).toBeGreaterThan(0);
  });

  it.each(animated.map((file) => [file.slice(CLIENT.length + 1), file]))(
    '%s has a prefers-reduced-motion block',
    (_name, file) => {
      expect(readFileSync(file, 'utf8')).toMatch(
        /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
      );
    },
  );
});
