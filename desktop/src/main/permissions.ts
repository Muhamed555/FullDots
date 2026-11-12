// What a page may ask the system for. Only FullDots' own pages are answered, and only for what the
// app uses: the microphone for voice, notifications, the clipboard and full screen.
import { session } from 'electron';
import { isShellPage } from './links';
import type { ShellPages } from './navigation';

const ALLOWED = new Set([
  'media',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
]);

export function restrictPermissions(pages: () => ShellPages): void {
  const ours = (url: string | undefined) =>
    isShellPage(url, { appOrigin: pages().appOrigin }) === 'app';

  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback, details) => {
      // Voice only listens: a page asking for the camera is refused.
      const video =
        permission === 'media' &&
        'mediaTypes' in details &&
        details.mediaTypes?.includes('video');
      callback(
        ALLOWED.has(permission) && !video && ours(details.requestingUrl),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      ALLOWED.has(permission) && ours(requestingOrigin),
  );
}
