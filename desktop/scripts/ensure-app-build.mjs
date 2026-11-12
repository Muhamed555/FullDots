// `npm start` in desktop/ runs the app from the repository root's build (dist/). This makes sure
// there is one. It does not rebuild a stale one: after changing server or client code, run
// "npm run build" in the root, or work against the live dev servers instead:
//
//   npm run dev                                                    # in the repository root
//   FULLDOTS_DESKTOP_URL=http://127.0.0.1:5173 npm start           # in desktop/
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const built = ['dist/server/server/index.js', 'dist/client/index.html'].every(
  (file) => existsSync(path.join(root, file)),
);

if (process.env.FULLDOTS_DESKTOP_URL)
  console.log(`Using the running app at ${process.env.FULLDOTS_DESKTOP_URL}.`);
else if (!built) {
  if (!existsSync(path.join(root, 'node_modules'))) {
    console.error(
      'The repository root has no node_modules. Run "npm ci" there first.',
    );
    process.exit(1);
  }
  console.log('Building the app in the repository root (first run)…');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}
