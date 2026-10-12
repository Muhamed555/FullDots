import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-backup-'));
  dirs.push(dir);
  return dir;
};

it('writes a consistent copy while the database is open, with the encryption key', () => {
  const data = temp();
  const out = temp();
  const path = join(data, 'opendots.sqlite');
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, 'owner', {
    connectorKey: Buffer.alloc(32, 7),
  });
  store.createTask('Back me up');
  writeFileSync(join(data, 'connector.key'), 'key-material');
  try {
    const output = execFileSync(process.execPath, ['scripts/backup.mjs', out], {
      env: { ...process.env, DATABASE_PATH: path, CONNECTOR_SECRET_KEY: '' },
      encoding: 'utf8',
    });
    expect(output).toContain('Backup written:');
    const files = readdirSync(out);
    const copy = files.find((name) => name.endsWith('.sqlite'))!;
    expect(copy).toMatch(/^fulldots-\d{4}-\d{2}-\d{2}T/);
    const restored = new DatabaseSync(join(out, copy));
    expect(
      restored
        .prepare('SELECT prompt FROM tasks')
        .all()
        .map((row) => row.prompt),
    ).toEqual(['Back me up']);
    expect(restored.prepare('SELECT COUNT(*) AS n FROM dots').get()!.n).toBe(1);
    restored.close();
    const key = files.find((name) => name.endsWith('.key'))!;
    expect(readFileSync(join(out, key), 'utf8')).toBe('key-material');
  } finally {
    store.close();
    workspace.close();
  }
});

it('says where the database should be when it is missing', () => {
  let message = '';
  try {
    execFileSync(process.execPath, ['scripts/backup.mjs', temp()], {
      env: { ...process.env, DATABASE_PATH: join(temp(), 'missing.sqlite') },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    message = String((error as { stderr?: string }).stderr);
  }
  expect(message).toContain('Set DATABASE_PATH');
});
