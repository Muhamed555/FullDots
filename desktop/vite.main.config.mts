import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// One version for the web app and the desktop app: the repository root's package.json.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

// https://vitejs.dev/config
export default defineConfig({
  define: { __FULLDOTS_VERSION__: JSON.stringify(version) },
});
