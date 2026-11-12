// Draws the side banner of the Windows setup wizard (installer/sidebar.bmp): the brand mark, the
// name and a row of Dots on the app's dark canvas. Run it with Electron, like make-icons.cjs:
//
//   npm run installer-art        # in desktop/
//
// The result is committed, so a build never needs to run this. Run it again when the brand changes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// NSIS shows the banner at 164 x 314 on the welcome and finish pages.
const WIDTH = 164;
const HEIGHT = 314;
const desktop = path.resolve(__dirname, '..');
const root = path.resolve(desktop, '..');
const brand = (file) =>
  fs.readFileSync(path.join(root, 'docs', 'brand', file)).toString('base64');
const font = pathToFileURL(
  path.join(
    root,
    'node_modules',
    '@fontsource-variable',
    'geist',
    'files',
    'geist-latin-wght-normal.woff2',
  ),
).href;

const page = `<!doctype html><html><head><style>
  @font-face { font-family: Geist; src: url('${font}') format('woff2'); font-weight: 100 900; }
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    background: radial-gradient(120% 70% at 50% 0%, #1e2140 0%, #121212 55%, #0a0a0a 100%);
    color: #f2f2f2; font-family: Geist, 'Segoe UI', sans-serif;
    display: flex; flex-direction: column; align-items: center;
  }
  .mark { width: 72px; height: 72px; margin-top: 46px; }
  h1 { margin: 14px 0 0; font-size: 22px; font-weight: 600; letter-spacing: -0.03em; }
  h1 span { color: #8c98ff; }
  p { margin: 8px 18px 0; font-size: 11px; line-height: 1.45; color: #a3a3a3; text-align: center; }
  .flock { margin-top: auto; margin-bottom: 26px; display: flex; gap: 2px; }
  .flock img { width: 28px; height: 28px; }
</style></head><body>
  <img class="mark" src="data:image/svg+xml;base64,${brand('fulldots-mark.svg')}">
  <h1>Full<span>Dots</span></h1>
  <p>AI coworkers with their own computers, on yours.</p>
  <div class="flock">
    ${['indigo', 'mint', 'coral', 'amber', 'lilac']
      .map(
        (color) =>
          `<img src="data:image/svg+xml;base64,${brand(`dot-${color}.svg`)}">`,
      )
      .join('')}
  </div>
</body></html>`;

/** A 24-bit Windows bitmap, which is what NSIS reads for its banners. */
function bmp(image) {
  const pixels = image.toBitmap(); // BGRA, top row first
  const rowSize = Math.ceil((WIDTH * 3) / 4) * 4;
  const data = Buffer.alloc(rowSize * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const from = (y * WIDTH + x) * 4;
      const to = (HEIGHT - 1 - y) * rowSize + x * 3; // bottom row first
      data[to] = pixels[from];
      data[to + 1] = pixels[from + 1];
      data[to + 2] = pixels[from + 2];
    }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(WIDTH, 18);
  header.writeInt32LE(HEIGHT, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(data.length, 34);
  header.writeInt32LE(2835, 38); // 72 dpi
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, data]);
}

app.whenReady().then(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fulldots-installer-'));
  const file = path.join(scratch, 'sidebar.html');
  fs.writeFileSync(file, page);
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await window.loadFile(file);
  await window.webContents.executeJavaScript('document.fonts.ready');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = (await window.webContents.capturePage()).resize({
    width: WIDTH,
    height: HEIGHT,
    quality: 'best',
  });
  window.destroy();
  const out = path.join(desktop, 'installer');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'sidebar.bmp'), bmp(image));
  fs.writeFileSync(path.join(scratch, 'sidebar.png'), image.toPNG());
  console.log(`Wrote installer/sidebar.bmp (preview: ${scratch}\\sidebar.png)`);
  app.quit();
});
