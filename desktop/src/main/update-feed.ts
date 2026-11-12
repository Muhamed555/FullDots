// Version arithmetic and the release lookup used where the system updater cannot install for us
// (Linux packages, and macOS builds that are not signed). Pure, so it is tested without a network.

export const RELEASE_REPOSITORY = 'asasemahmed/FullDots';

type Parsed = { core: number[]; pre: string[] };

function parseVersion(version: string): Parsed | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
    version.trim(),
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** Semantic version order: is `candidate` a later release than `current`? */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1)
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index];
  // 2.1.0 is later than 2.1.0-rc.1; two pre-releases compare part by part.
  if (!a.pre.length || !b.pre.length) return !a.pre.length && !!b.pre.length;
  for (
    let index = 0;
    index < Math.max(a.pre.length, b.pre.length);
    index += 1
  ) {
    const left = a.pre[index];
    const right = b.pre[index];
    if (left === undefined) return false;
    if (right === undefined) return true;
    if (left === right) continue;
    const numeric = /^\d+$/;
    if (numeric.test(left) && numeric.test(right))
      return Number(left) > Number(right);
    if (numeric.test(left) !== numeric.test(right)) return !numeric.test(left);
    return left > right;
  }
  return false;
}

export function latestReleaseUrl(repository = RELEASE_REPOSITORY): string {
  return `https://api.github.com/repos/${repository}/releases/latest`;
}

/**
 * The newer release in GitHub's "latest release" answer, if there is one. The page address is
 * accepted only on github.com under the same repository: it is opened in the person's browser.
 */
export function newerRelease(
  body: unknown,
  current: string,
  repository = RELEASE_REPOSITORY,
): { version: string; url: string } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const release = body as Record<string, unknown>;
  if (release.draft === true || release.prerelease === true) return undefined;
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const version = tag.replace(/^v/, '');
  if (!isNewerVersion(version, current)) return undefined;
  const fallback = `https://github.com/${repository}/releases/latest`;
  const page = typeof release.html_url === 'string' ? release.html_url : '';
  const url = page.startsWith(`https://github.com/${repository}/releases/`)
    ? page
    : fallback;
  return { version, url };
}

/** The version inside an updater's release name ("FullDots 2.1.0", "v2.1.0"); empty when none. */
export function versionInName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(name)?.[0] ?? '';
}
