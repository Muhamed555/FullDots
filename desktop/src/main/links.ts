// Where a URL may go from the desktop window. Pure, so it is tested without a window.

export type LinkTarget =
  /** A page of the app: stays in the window. */
  | 'app'
  /** A file or download served by the app's own API: opens in the person's browser. */
  | 'app-api'
  /** Another site, or an email address: opens with the system's default application. */
  | 'external'
  | 'blocked';

function parse(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function classifyLink(url: string, appOrigin: string): LinkTarget {
  const target = parse(url);
  if (!target) return 'blocked';
  if (target.origin === parse(appOrigin)?.origin)
    return target.pathname.startsWith('/api/') ? 'app-api' : 'app';
  if (target.protocol === 'https:' || target.protocol === 'http:')
    return target.username || target.password ? 'blocked' : 'external';
  if (target.protocol === 'mailto:') return 'external';
  return 'blocked';
}

/** A blank window the page opens first and points at an address afterwards (connector sign-in). */
export function isBlankPopup(url: string): boolean {
  return url === '' || url === 'about:blank';
}

/** Whether a request comes from a page the shell itself loaded: the app, or the boot screen. */
export function isShellPage(
  url: string | undefined,
  pages: { appOrigin?: string; bootUrl?: string },
): 'app' | 'boot' | undefined {
  if (!url) return undefined;
  const page = parse(url);
  if (!page) return undefined;
  if (pages.appOrigin && page.origin === parse(pages.appOrigin)?.origin)
    return 'app';
  const boot = pages.bootUrl ? parse(pages.bootUrl) : undefined;
  if (!boot) return undefined;
  // A file: page has no origin to compare, so the path has to be the boot screen's own.
  if (boot.protocol === 'file:')
    return page.protocol === 'file:' && page.pathname === boot.pathname
      ? 'boot'
      : undefined;
  return page.origin === boot.origin ? 'boot' : undefined;
}
