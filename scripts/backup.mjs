// Writes a consistent copy of the FullDots database, safe while the server is running.
//
//   npm run backup                # backups/fulldots-<time>.sqlite (+ the connector key)
//   npm run backup -- /some/dir   # somewhere else
//
// The database holds conversations, pages, settings, tasks and the audit trail. Stored model keys
// and connector tokens are encrypted with data/connector.key (or CONNECTOR_SECRET_KEY): a copy of
// the key is saved next to the backup, and both are needed to restore. Keep them somewhere safe.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const database = resolve(process.env.DATABASE_PATH ?? 'data/opendots.sqlite');
const target = resolve(process.argv[2] ?? process.env.BACKUP_DIR ?? 'backups');
if (!existsSync(database)) {
  console.error(
    `No database at ${database}. Set DATABASE_PATH if it lives elsewhere.`,
  );
  process.exit(1);
}
mkdirSync(target, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
const file = join(target, `fulldots-${stamp}.sqlite`);

const db = new DatabaseSync(database);
try {
  db.exec('PRAGMA busy_timeout=5000');
  // VACUUM INTO reads one consistent snapshot, even with the server writing in WAL mode.
  db.prepare('VACUUM INTO ?').run(file);
} finally {
  db.close();
}
console.log(
  `Backup written: ${file} (${Math.round(statSync(file).size / 1024)} KB)`,
);

const key = join(dirname(database), 'connector.key');
if (process.env.CONNECTOR_SECRET_KEY)
  console.log(
    'Stored keys use CONNECTOR_SECRET_KEY from the environment: keep that value with the backup.',
  );
else if (existsSync(key)) {
  const keyCopy = join(target, `connector-${stamp}.key`);
  copyFileSync(key, keyCopy);
  console.log(
    `Encryption key copied: ${keyCopy} (needed to read stored model keys and connector tokens).`,
  );
}
