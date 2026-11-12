// Draws the app's icons from the brand mark (docs/brand/fulldots-mark.svg). Run it with Electron,
// which brings the SVG renderer and the image resizer; nothing else is installed for it:
//
//   npm run icons        # in desktop/
//
// The results are committed (assets/icons), so a build never needs to run this. Run it again only
// when the mark changes.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const out = path.join(desktop, 'assets', 'icons');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fulldots-icons-'));
const svg = fs.readFileSync(
  path.resolve(desktop, '..', 'docs', 'brand', 'fulldots-mark.svg'),
);

/** The mark on a transparent square, `inset` of the side left empty around it. */
async function draw(size, inset) {
  const window = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true },
  });
  const side = Math.round(size * (1 - inset * 2));
  const page = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <div style="width:${size}px;height:${size}px;display:grid;place-items:center">
      <img width="${side}" height="${side}" src="data:image/svg+xml;base64,${svg.toString('base64')}">
    </div></body></html>`;
  // A file, not a data: address: Chromium refuses to open a window on one.
  const file = path.join(scratch, `mark-${size}-${inset}.html`);
  fs.writeFileSync(file, page);
  await window.loadFile(file);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await window.webContents.capturePage();
  window.destroy();
  // A scaled display captures more pixels than asked for; bring it back to the exact size.
  return image.resize({ width: size, height: size, quality: 'best' });
}

const png = (image, size) =>
  image.resize({ width: size, height: size, quality: 'best' }).toPNG();

/** A Windows .ico: classic bitmaps for the small sizes, a PNG for 256, as Windows expects. */
function ico(image) {
  const entries = [16, 20, 24, 32, 40, 48, 64, 128, 256].map((size) => {
    if (size === 256) return { size, data: png(image, size) };
    const pixels = image
      .resize({ width: size, height: size, quality: 'best' })
      .toBitmap(); // BGRA, top row first
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8); // colour rows plus the mask rows
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(size * size * 4, 20);
    const rows = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1)
      pixels.copy(
        rows,
        (size - 1 - y) * size * 4,
        y * size * 4,
        (y + 1) * size * 4,
      );
    // The 1-bit mask is unused with 32-bit colour, but has to be there: rows padded to 4 bytes.
    const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
    return { size, data: Buffer.concat([header, rows, mask]) };
  });
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  entries.forEach(({ size, data }, index) => {
    const at = 6 + index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, at);
    directory.writeUInt8(size === 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

/** A macOS .icns: PNGs under the type codes for each size and its Retina twin. */
function icns(image) {
  const types = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ];
  const chunks = types.map(([type, size]) => {
    const data = png(image, size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(
    8 + chunks.reduce((total, chunk) => total + chunk.length, 0),
    4,
  );
  return Buffer.concat([head, ...chunks]);
}

app.disableHardwareAcceleration();
// Draw at one pixel per pixel whatever the display's scaling, or the mark is cropped.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Each drawing closes its window; without this, closing the first one would quit the app.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  // Windows and Linux: the mark fills the square. macOS: the usual margin around an app icon.
  const full = await draw(1024, 0);
  const padded = await draw(1024, 0.09);
  const write = (name, data) => {
    fs.writeFileSync(path.join(out, name), data);
    console.log(`${name}  ${(data.length / 1024).toFixed(1)} kB`);
  };
  write('icon.png', png(full, 512));
  write('icon.ico', ico(full));
  write('icon.icns', icns(padded));
  write('tray-16.png', png(full, 16));
  write('tray-32.png', png(full, 32));
  const { width, height } = full.getSize();
  console.log(`Drawn at ${width}x${height}.`);
  fs.rmSync(scratch, { recursive: true, force: true });
  app.quit();
});
