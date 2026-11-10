# FullDots Desktop

FullDots as an app on your computer, for Windows, macOS and Linux. It is the same FullDots as the
web app: the same Dots, Spaces, connectors and settings. The difference is where it runs. The
desktop app starts FullDots on your own machine, so there is no server to set up and nothing to
keep open in a browser.

## Install

Download the installer for your system from the
[latest release](https://github.com/asasemahmed/FullDots/releases/latest):

| System  | File                               |
| ------- | ---------------------------------- |
| Windows | `FullDots-x.y.z-Setup.exe`         |
| macOS   | `FullDots-darwin-<arch>-x.y.z.zip` |
| Linux   | the `.deb` or the `.rpm`           |

Open FullDots, then add a model in **Settings → Models**. Everything else works as described in
the rest of these docs.

Until the installers are signed, Windows shows a SmartScreen notice the first time (choose **More
info**, then **Run anyway**), and macOS asks you to allow the app in **System Settings → Privacy
& Security**.

## What is different from the web app

- **A quiet start.** A new chat is one line of text and the message box. The computer panel, the
  Dot's profile and the other places stay closed until you open them: the computer and pause
  icons are in the title strip, and everything else is on the rail.
- **Your model key.** The first screen has an **Open Settings** button that goes straight to
  **Settings → Models**. Pick a provider, paste its key, and choose a default model. The key is
  encrypted in your data folder and is not shown again.
- **A window of its own.** The top of the app is the title bar: drag it to move the window. Your
  Dots are a slim rail on the left; click the panel icon at its top to open the full sidebar.
- **It keeps running.** On Windows, closing the window leaves FullDots in the tray, so scheduled
  work and connected channels carry on. Open it again, or quit it, from the tray icon. The tray
  menu can turn this off, and can start FullDots when you sign in.
- **It updates itself.** When a new version is ready, a notice appears in the corner with a
  Restart button. On Linux, and on macOS until the app is signed, the notice links to the
  download instead. **Help → Check for Updates…** looks right away.
- **Links open in your browser.** A link to another site, and a connector's sign-in, open in your
  own browser, where your sign-ins and password manager already are.

## Your data

FullDots Desktop listens on this computer only (`127.0.0.1`) and keeps everything in one folder.
**File → Open Data Folder** (or the tray menu) opens it:

| System  | Folder                                             |
| ------- | -------------------------------------------------- |
| Windows | `%APPDATA%\FullDots\workspace`                     |
| macOS   | `~/Library/Application Support/FullDots/workspace` |
| Linux   | `~/.config/FullDots/workspace`                     |

It is laid out like a self-hosted FullDots: a `data` folder with the database, and an optional
`.env` file. To move from the web app to the desktop app on the same machine, quit both and copy
your `data` folder in. Back it up by copying the folder while FullDots is not running.

## Settings in `.env`

Most settings are in the app. For the ones that are environment variables (see
[`.env.example`](../.env.example)), create a file named `.env` in the data folder and restart
FullDots. For example, to use another port:

```
PORT=4500
```

The desktop app always listens on this computer only, so `HOST` and `APP_ORIGIN` are ignored.
To reach FullDots from other devices, run the [server](SETUP.md) instead.

## Not in the desktop app yet

- **The guided Docker setup for Dot computers.** A Dot can still use a computer service you run
  yourself: start it as described in [Dot computers](COMPUTERS.md) and set
  `COMPUTER_SUPERVISOR_URL` and its tokens in the data folder's `.env`.
- **The page reader.** Search and research work; the isolated page reader is a separate service.
  Run it as described in [Setup](SETUP.md) and set `BROWSER_URL` and `BROWSER_SECRET`.

## If it does not start

The window shows what went wrong, with **Try again**, **Open logs** and **Open data folder**. The
log is `desktop.log` in the logs folder. A common cause is a `.env` setting the server refuses;
the log names it.

For building the app or changing it, see [`desktop/README.md`](../desktop/README.md).
