import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// One version for the web app and the desktop app: the repository root's package.json. This
// package's own "version" is a placeholder, stamped below, so there is nothing to keep in step.
const root = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string; license: string };
const version = root.version;

const DESCRIPTION =
  'Self-hosted, local-first AI coworkers with their own computers.';
const HOMEPAGE = 'https://github.com/asasemahmed/FullDots';
const linux = {
  name: 'fulldots',
  productName: 'FullDots',
  genericName: 'AI Workspace',
  description: DESCRIPTION,
  bin: 'fulldots',
  icon: 'assets/icons/icon.png',
  categories: ['Office' as const, 'Utility' as const],
  homepage: HOMEPAGE,
};

// Signing is switched on by the environment, so a contributor's build needs no certificates and
// the release workflow signs when its secrets are present (see desktop/README.md).
const windowsCertificate = process.env.WINDOWS_CERTIFICATE_FILE;
const appleId = process.env.APPLE_ID;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'FullDots',
    executableName: 'fulldots',
    appBundleId: 'com.fulldots.desktop',
    appCategoryType: 'public.app-category.productivity',
    appVersion: version,
    appCopyright: `Copyright © ${new Date().getFullYear()} FullDots contributors`,
    // .ico on Windows, .icns on macOS; the extension is added per platform.
    icon: 'assets/icons/icon',
    // The server build, its node_modules and the web client, staged by scripts/stage-server.mjs.
    // They sit beside the app, not inside its archive: a server needs real files to serve.
    extraResource: ['.stage/server'],
    extendInfo: {
      NSMicrophoneUsageDescription:
        'FullDots uses the microphone when you talk to a Dot.',
    },
    win32metadata: {
      CompanyName: 'FullDots',
      FileDescription: 'FullDots',
      ProductName: 'FullDots',
    },
    ...(appleId
      ? {
          osxSign: {},
          osxNotarize: {
            appleId,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD ?? '',
            teamId: process.env.APPLE_TEAM_ID ?? '',
          },
        }
      : {}),
  },
  rebuildConfig: {},
  hooks: {
    // What the makers read: installers are named and versioned from the root version.
    readPackageJson: async (_config, packageJson) => ({
      ...packageJson,
      version,
    }),
    // What the installed app reads (`app.getVersion()`, which the updater compares against).
    // After pruning, not after copying: the Vite plugin writes package.json in its own
    // after-copy step, which runs later than this file's.
    packageAfterPrune: async (_config, buildPath) => {
      const file = path.join(buildPath, 'package.json');
      const packaged = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(
        file,
        `${JSON.stringify({ ...packaged, version }, null, 2)}\n`,
      );
    },
  },
  makers: [
    new MakerSquirrel({
      name: 'FullDots',
      exe: 'fulldots.exe',
      setupExe: `FullDots-${version}-Setup.exe`,
      setupIcon: 'assets/icons/icon.ico',
      iconUrl: `https://raw.githubusercontent.com/asasemahmed/FullDots/main/desktop/assets/icons/icon.ico`,
      authors: 'FullDots',
      description: DESCRIPTION,
      noMsi: true,
      ...(windowsCertificate
        ? {
            certificateFile: windowsCertificate,
            certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
          }
        : {}),
    }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({ options: { ...linux, license: root.license } }),
    new MakerDeb({
      options: { ...linux, maintainer: 'FullDots', section: 'utils' },
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
