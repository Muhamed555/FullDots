// What the guided Docker setup for Dot computers needs beside the server: the compose file and the
// build files it names. A self-hosted checkout has them in its folder; the desktop app keeps a copy
// in the data folder, which is where the server runs and where `.env` (with the tokens the setup
// writes) already lives.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const COMPOSE_FILE = 'compose.computers.yml';
const BUILD_FILES = path.join('deployment', 'computers');

/**
 * The images are built with the data folder as their context. Only the build files may be sent to
 * Docker: never the database, the key or `.env`.
 */
export const DOCKERIGNORE = `# Written by FullDots Desktop on every start. Do not edit.
# Building a Dot's computer sends only deployment/ to Docker, never your data.
*
!deployment
`;

/** Copies the kit into the data folder. Returns whether there was one to copy. */
export function syncComputerKit(kit: string, home: string): boolean {
  const compose = path.join(kit, COMPOSE_FILE);
  const files = path.join(kit, BUILD_FILES);
  if (!existsSync(compose) || !existsSync(files)) return false;
  mkdirSync(home, { recursive: true });
  // Overwritten each start, so an updated app brings its own versions of these files.
  cpSync(compose, path.join(home, COMPOSE_FILE));
  cpSync(files, path.join(home, BUILD_FILES), { recursive: true, force: true });
  writeFileSync(path.join(home, '.dockerignore'), DOCKERIGNORE);
  return true;
}
