// Stages what the desktop app runs: the server build, the files it imports from node_modules, and
// the web client, laid out the way the Docker image lays them out. Forge then copies the folder
// into the app as `resources/server` (forge.config.mts, extraResource).
//
//   node scripts/stage-server.mjs               # builds the repository root first
//   node scripts/stage-server.mjs --skip-build  # uses the dist/ that is already there
import { execSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { nodeFileTrace } from '@vercel/nft';

const desktop = path.resolve(import.meta.dirname, '..');
const root = path.resolve(desktop, '..');
const stage = path.join(desktop, '.stage', 'server');
const skipBuild = process.argv.includes('--skip-build');

const run = (command, cwd) => {
  console.log(`\n> ${command}  (${path.relative(root, cwd) || '.'})`);
  execSync(command, { cwd, stdio: 'inherit' });
};

if (!existsSync(path.join(root, 'node_modules'))) {
  console.error(
    'The repository root has no node_modules. Run "npm ci" there first.',
  );
  process.exit(1);
}
if (!skipBuild) run('npm run build', root);
for (const built of ['dist/server/server/index.js', 'dist/client/index.html'])
  if (!existsSync(path.join(root, built))) {
    console.error(
      `Missing ${built}. Run "npm run build" in the repository root.`,
    );
    process.exit(1);
  }

rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'dist'), { recursive: true });

// Only the files the server can reach, found by following its imports from the entry point. The
// root's node_modules also holds everything the web client is built from (React, the editor, the
// icon sets), none of which a running server opens: installing all production dependencies here
// would make the app ten times the size.
const entry = path.join(root, 'dist', 'server', 'server', 'index.js');
const { fileList, warnings } = await nodeFileTrace([entry], {
  base: root,
  processCwd: root,
});
for (const warning of warnings)
  // Optional native speed-ups (ws) and the like are reported as unresolved; real gaps are caught
  // by the app's smoke test, which starts this exact folder.
  if (process.argv.includes('--verbose')) console.warn(`  ${warning.message}`);
for (const file of fileList) {
  const target = path.join(stage, file);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(root, file), target);
}
// "type": "module" for the server build, and the name and version the server reports.
copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));

cpSync(path.join(root, 'dist', 'client'), path.join(stage, 'dist', 'client'), {
  recursive: true,
});
copyFileSync(
  path.join(desktop, 'resources', 'server-host.mjs'),
  path.join(stage, 'server-host.mjs'),
);

let files = 0;
let bytes = 0;
let longest = '';
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      files += 1;
      bytes += statSync(full).size;
      const relative = path.relative(stage, full);
      if (relative.length > longest.length) longest = relative;
    }
  }
};
walk(stage);
console.log(
  `\nStaged ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, in ${path.relative(root, stage)}`,
);
// Windows installs under %LocalAppData%\FullDots\app-x.y.z\resources\server: about 70 characters
// before these paths, and a 260-character limit on many machines.
console.log(`Longest path: ${longest.length} characters`);
if (longest.length > 170)
  console.warn(`Warning: this path may be too long on Windows:\n  ${longest}`);
