// A Windows setup wizard for Forge: the app Forge packaged, wrapped by electron-builder's NSIS
// installer. The person sees a welcome page, the license, where to install and shortcuts, then a
// finish page that can open FullDots. electron-builder also writes `latest.yml` and a blockmap,
// which electron-updater reads to update an installed copy in place (src/main/updates.ts).
import path from 'node:path';
import { MakerBase, type MakerOptions } from '@electron-forge/maker-base';
import type { ForgePlatform } from '@electron-forge/shared-types';
import { Arch, build, Platform, type Configuration } from 'electron-builder';

export interface MakerNsisConfig {
  /** Shown in Windows' installed-apps list and used for shortcuts and notifications. */
  appId: string;
  productName: string;
  /** Where releases are published; electron-builder writes it into `latest.yml`. */
  github: { owner: string; repo: string };
  /** Relative to the desktop package. */
  license: string;
  icon: string;
  sidebar: string;
  include: string;
  /** Optional: a .pfx and its password. Without them the installer is unsigned. */
  certificateFile?: string;
  certificatePassword?: string;
}

const ARCHES: Record<string, Arch> = {
  x64: Arch.x64,
  arm64: Arch.arm64,
  ia32: Arch.ia32,
};

export class MakerNsis extends MakerBase<MakerNsisConfig> {
  name = 'nsis';
  defaultPlatforms: ForgePlatform[] = ['win32'];

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === 'win32';
  }

  async make({ dir, makeDir, targetArch, packageJSON }: MakerOptions) {
    const arch = ARCHES[targetArch];
    if (arch === undefined)
      throw new Error(`The Windows installer is not made for ${targetArch}.`);
    const config = this.config;
    const projectDir = process.cwd();
    const output = path.resolve(makeDir, 'nsis', targetArch);
    await this.ensureDirectory(output);
    const signing: Configuration['win'] = config.certificateFile
      ? {
          signtoolOptions: {
            certificateFile: config.certificateFile,
            certificatePassword: config.certificatePassword,
          },
        }
      : {};
    const artifacts = await build({
      projectDir,
      prepackaged: dir,
      targets: Platform.WINDOWS.createTarget('nsis', arch),
      publish: 'never',
      config: {
        appId: config.appId,
        productName: config.productName,
        // The desktop package's own version is a placeholder; Forge hands over the real one.
        extraMetadata: { version: packageJSON.version },
        directories: { output },
        publish: {
          provider: 'github',
          owner: config.github.owner,
          repo: config.github.repo,
        },
        win: { icon: config.icon, ...signing },
        nsis: {
          // A wizard, not a one-click install: welcome, license, install mode and folder.
          oneClick: false,
          perMachine: false,
          allowElevation: true,
          allowToChangeInstallationDirectory: true,
          license: config.license,
          installerIcon: config.icon,
          uninstallerIcon: config.icon,
          installerHeaderIcon: config.icon,
          installerSidebar: config.sidebar,
          uninstallerSidebar: config.sidebar,
          include: config.include,
          createDesktopShortcut: true,
          createStartMenuShortcut: true,
          shortcutName: config.productName,
          uninstallDisplayName: config.productName,
          runAfterFinish: true,
          // Your workspace is in your profile folder, not the install folder: an uninstall
          // leaves it, so reinstalling picks up where you were.
          deleteAppDataOnUninstall: false,
          artifactName: `${config.productName}-\${version}-Setup.\${ext}`,
        },
      },
    });
    return artifacts.filter((file) => /\.(exe|yml|blockmap)$/i.test(file));
  }
}
