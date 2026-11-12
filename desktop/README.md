# FullDots Desktop

FullDots in a window of its own, for Windows, macOS and Linux. It is built with
[Electron](https://www.electronjs.org) from the standard
[Electron Forge](https://www.electronforge.io) Vite + TypeScript template.

For installing and using the app, see [`docs/DESKTOP.md`](../docs/DESKTOP.md). This page is for
working on it.

## One app, two shells

The desktop app is not a second copy of FullDots. It runs **the same server build** and opens
**the same web client** that a browser does:

```
repository root                       desktop/
───────────────                       ────────
src/server  ──┐                       src/main.ts        starts the server, opens the window
src/client  ──┼─ npm run build ─▶ dist/ ─▶ loaded by the shell
src/shared  ──┘                       src/preload.ts     the small bridge the page can see
                                      index.html         the boot screen, shown while starting
```

So a change to a screen, an API route or a Dot's behaviour is made once, in `src/`, and reaches
the web app and the desktop app together. Nothing is copied between them.

What lives in `desktop/` is only what a browser tab cannot do:

| File                        | What it does                                                                |
| --------------------------- | --------------------------------------------------------------------------- |
| `src/main.ts`               | The entry point: one instance, the window, quitting cleanly.                |
| `src/main/server.ts`        | Runs the server in a utility process, waits for it, stops it.               |
| `src/main/server-env.ts`    | The environment the server starts with (this machine only, the data folder) |
| `src/main/window.ts`        | The frameless window and the system's window buttons over the page.         |
| `src/main/navigation.ts`    | Keeps the window on FullDots; other sites open in the browser.              |
| `src/main/page-reader.ts`   | Runs the page reader beside the server, driving an installed browser.       |
| `src/main/computer-kit.ts`  | Keeps the Docker setup files for Dot computers in the data folder.          |
| `src/main/updates.ts`       | Updates from GitHub releases.                                               |
| `src/main/tray.ts`          | The tray icon: keep running when the window is closed.                      |
| `src/main/menu.ts`          | The application menu and its keyboard shortcuts.                            |
| `src/main/permissions.ts`   | Microphone, notifications and clipboard for FullDots' own pages only.       |
| `src/preload.ts`            | `window.fulldotsDesktop`, and `data-desktop` on `<html>`.                   |
| `index.html`, `renderer.ts` | The boot screen, and the screen shown when the server cannot start.         |
| `resources/server-host.mjs` | Lets the shell ask the server to stop cleanly on every platform.            |
| `scripts/stage-server.mjs`  | Collects the server build and only the files it imports, for packaging.     |
| `forge.config.mts`          | Packaging, installers and signing.                                          |

The web app knows about the desktop in a few small places, all of which do nothing in a browser:

- [`src/shared/desktop-bridge.ts`](../src/shared/desktop-bridge.ts): the typed contract between
  the page and the shell. Both sides import it, so a change is checked against both.
- [`src/client/desktop/desktop.css`](../src/client/desktop/desktop.css): what a window of its
  own adds to the page: the strip along the top drags the window, and its buttons keep clear of
  the system's. The look itself (frame, rail, panel) is `src/client/shell.css` and is the same in
  a browser.
- [`src/client/desktop/DesktopUpdateNotice.tsx`](../src/client/desktop/DesktopUpdateNotice.tsx):
  the "update is ready" notice.

The server has two settings for it: `CLIENT_DIR`, the folder of the built web client, because
the desktop server's working directory is the person's data folder; and
`BROWSER_EXECUTABLE_PATH`, so the page reader drives a browser that is already installed.

## Run it

Node.js 24 or newer. From the repository root:

```bash
npm ci
npm --prefix desktop ci
npm run desktop
```

`npm run desktop` builds the web app and starts the shell on that build. It uses a profile of its
own (`FullDots Dev`), so it never opens the data of an installed copy.

To work on a screen with live reload, run the web app as usual and point the shell at it:

```bash
npm run dev
```

```bash
FULLDOTS_DESKTOP_URL=http://127.0.0.1:5173 npm --prefix desktop start
```

On Windows PowerShell, set the variable first: `$env:FULLDOTS_DESKTOP_URL = 'http://127.0.0.1:5173'`.

## Check it

```bash
npm test                       # unit tests, including tests/desktop-*.test.ts(x)
npm --prefix desktop run typecheck
npm --prefix desktop run package
npm --prefix desktop run test:e2e
```

`test:e2e` opens the real window with a throwaway profile and checks what only a window can show:
the workspace loads, the page has the bridge and no Node.js, the window follows the theme, other
sites open in the browser, quitting stops the server, and a server that cannot start says so.
Screenshots land in `desktop/out/e2e`.

## Build the installers

```bash
npm run desktop:make
```

This builds the web app, stages the server (`desktop/.stage/server`) and makes the installers for
the platform you are on, in `desktop/out/make`:

| Platform | Result                                                    |
| -------- | --------------------------------------------------------- |
| Windows  | `FullDots-x.y.z-Setup.exe` (Squirrel)                     |
| macOS    | `FullDots-x.y.z-<arch>.dmg`, and a `.zip` for the updater |
| Linux    | `.deb` and `.rpm` (the latter needs `rpm`)                |

## One version, one release

There is one version number: `version` in the **root** `package.json`. The `version` in
`desktop/package.json` is a placeholder; the build stamps the root version into the app
(`forge.config.mts`), so the two can never drift.

To release a new version of FullDots, web and desktop together:

1. Set `version` in the root `package.json` and update `CHANGELOG.md`.
2. Publish a GitHub release with the tag `v<version>`.

Publishing the release starts two workflows:

- [`release-images.yml`](../.github/workflows/release-images.yml) builds and pushes the Docker
  images that web deployments pull.
- [`release-desktop.yml`](../.github/workflows/release-desktop.yml) builds the installers on
  Windows, macOS and Linux and attaches them to the release.

Installed desktop apps then find the new release themselves:

- **Windows** checks [update.electronjs.org](https://github.com/electron/update.electronjs.org)
  (free for public repositories, and the service Electron's own documentation uses), downloads
  the update in the background and shows "FullDots x.y.z is ready" with a Restart button.
- **macOS** does the same once the app is signed and notarised (see below). Unsigned, it shows
  the notice with a link to the download instead.
- **Linux** shows the notice with a link to the download.

## Signing

Signing is optional and switched on by environment variables, so a contributor's build needs no
certificates. Set these as repository secrets for the release workflow:

| Secret                         | For                                                  |
| ------------------------------ | ---------------------------------------------------- |
| `WINDOWS_CERTIFICATE`          | A code signing certificate (`.pfx`), base64-encoded. |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password.                                        |
| `APPLE_ID`                     | The Apple ID of a Developer Program member.          |
| `APPLE_APP_SPECIFIC_PASSWORD`  | An app-specific password for that Apple ID.          |
| `APPLE_TEAM_ID`                | The team to sign and notarise as.                    |

Without them, Windows shows a SmartScreen warning on first install, and macOS asks the person to
allow the app in System Settings.

## Icons

`assets/icons` is drawn from `docs/brand/fulldots-mark.svg` and committed. After changing the
mark, run `npm --prefix desktop run icons`.
