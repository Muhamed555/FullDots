// Finds a Chromium-based browser already on this computer for the page reader to drive, so the
// desktop app does not ship or download a second one. Pure, so it is tested without a disk.
import path from 'node:path';

export function browserCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === 'win32') {
    const roots = [
      env['ProgramFiles(x86)'],
      env.ProgramFiles,
      env.LOCALAPPDATA,
    ].filter((root): root is string => !!root);
    // Edge first: every supported Windows has it.
    return [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ].flatMap((parts) => roots.map((root) => path.win32.join(root, ...parts)));
  }
  if (platform === 'darwin')
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}

/** The first installed browser, or nothing: the page reader is then simply not started. */
export function findBrowser(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists: (file: string) => boolean,
): string | undefined {
  return browserCandidates(platform, env).find(exists);
}
