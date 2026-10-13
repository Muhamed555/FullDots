// Small JPEG keyframes for computer replay. The computer's screenshot call only returns a full-size
// PNG, and the app has no image library, so this decodes that PNG, scales it down and encodes a
// baseline JPEG (4:2:0, standard Huffman tables). It handles what a browser screenshot is: 8-bit,
// non-interlaced greyscale, RGB or RGBA.
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Far beyond a 1280x800 screen; refuses to inflate anything unreasonable. */
const MAX_PIXELS = 4096 * 4096;

export interface RgbImage {
  width: number;
  height: number;
  /** Three bytes per pixel, row by row. */
  data: Uint8Array;
}

export function decodePng(png: Uint8Array): RgbImage {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error('Not a PNG image.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colour];
      if (depth !== 8 || !channels || interlace !== 0)
        throw new Error('Unsupported PNG format.');
      if (!width || !height || width * height > MAX_PIXELS)
        throw new Error('PNG image is too large.');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!channels || !idat.length) throw new Error('PNG image has no pixels.');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat), {
    maxOutputLength: (stride + 1) * height,
  });
  if (raw.length < (stride + 1) * height)
    throw new Error('PNG image is truncated.');
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    const above = row - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[above + x] : 0;
      const corner = y > 0 && x >= channels ? pixels[above + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - corner);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) throw new Error('PNG image is corrupt.');
      pixels[row + x] = (raw[source + x] + predictor) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index++) {
    const from = index * channels;
    if (channels < 3) {
      // Greyscale, with or without alpha. Alpha is dropped: a screenshot is opaque.
      data.fill(pixels[from], index * 3, index * 3 + 3);
    } else {
      data[index * 3] = pixels[from];
      data[index * 3 + 1] = pixels[from + 1];
      data[index * 3 + 2] = pixels[from + 2];
    }
  }
  return { width, height, data };
}

/** Scales down to at most `maxWidth` wide by averaging each source box. Never scales up. */
export function shrink(image: RgbImage, maxWidth: number): RgbImage {
  if (image.width <= maxWidth) return image;
  const width = maxWidth;
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const sx = image.width / width;
  const sy = image.height / height;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(
      y0 + 1,
      Math.min(image.height, Math.floor((y + 1) * sy)),
    );
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(
        x0 + 1,
        Math.min(image.width, Math.floor((x + 1) * sx)),
      );
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const at = (yy * image.width + xx) * 3;
          r += image.data[at];
          g += image.data[at + 1];
          b += image.data[at + 2];
        }
      const count = (y1 - y0) * (x1 - x0);
      const to = (y * width + x) * 3;
      data[to] = Math.round(r / count);
      data[to + 1] = Math.round(g / count);
      data[to + 2] = Math.round(b / count);
    }
  }
  return { width, height, data };
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];
const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
  24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_QUANT = [
  17,
  18,
  24,
  47,
  99,
  99,
  99,
  99,
  18,
  21,
  26,
  66,
  99,
  99,
  99,
  99,
  24,
  26,
  56,
  99,
  99,
  99,
  99,
  99,
  47,
  66,
  99,
  99,
  99,
  99,
  99,
  99,
  ...Array<number>(32).fill(99),
];
// The standard Huffman tables of the JPEG specification (Annex K.3): counts of codes of each length
// from 1 to 16 bits, then the symbols in code order.
const DC_LUMA = {
  counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const DC_CHROMA = {
  counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const AC_LUMA = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  symbols: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const AC_CHROMA = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  symbols: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41,
    0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1,
    0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
    0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a,
    0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
    0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
type HuffmanSpec = { counts: number[]; symbols: number[] };
/** Huffman code and its length in bits, indexed by symbol. */
type Codes = { code: Uint16Array; length: Uint8Array };
function codesFor(spec: HuffmanSpec): Codes {
  const codes: Codes = {
    code: new Uint16Array(256),
    length: new Uint8Array(256),
  };
  let code = 0;
  let next = 0;
  for (let length = 1; length <= 16; length++) {
    for (let index = 0; index < spec.counts[length - 1]; index++) {
      const symbol = spec.symbols[next++];
      codes.code[symbol] = code++;
      codes.length[symbol] = length;
    }
    code <<= 1;
  }
  return codes;
}
const scaled = (table: number[], quality: number) => {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const factor = q < 50 ? 5000 / q : 200 - q * 2;
  return table.map((value) =>
    Math.min(255, Math.max(1, Math.floor((value * factor + 50) / 100))),
  );
};
// Orthonormal DCT basis, which is exactly the JPEG forward DCT.
const BASIS = Float64Array.from({ length: 64 }, (_, index) => {
  const u = index >> 3;
  const x = index & 7;
  return (
    (u === 0 ? Math.SQRT1_2 : 1) *
    0.5 *
    Math.cos(((2 * x + 1) * u * Math.PI) / 16)
  );
});

class BitWriter {
  private bytes = new Uint8Array(64 * 1024);
  private size = 0;
  private buffer = 0;
  private count = 0;
  /** Appends the low `length` bits of `code`, most significant first. `length` is at most 16. */
  write(code: number, length: number) {
    this.buffer = (this.buffer << length) | (code & ((1 << length) - 1));
    this.count += length;
    while (this.count >= 8) {
      this.count -= 8;
      const byte = (this.buffer >> this.count) & 0xff;
      this.push(byte);
      // A 0xFF in entropy-coded data must be followed by a zero byte.
      if (byte === 0xff) this.push(0);
    }
    this.buffer &= (1 << this.count) - 1;
  }
  private push(byte: number) {
    if (this.size === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.size++] = byte;
  }
  finish(): Uint8Array {
    if (this.count) this.write(0x7f, 8 - this.count);
    return this.bytes.subarray(0, this.size);
  }
}

/** Encodes RGB pixels as a baseline JPEG at the given quality (1-100). */
export function encodeJpeg(image: RgbImage, quality = 60): Buffer {
  const { width, height, data } = image;
  const lumaQuant = scaled(LUMA_QUANT, quality);
  const chromaQuant = scaled(CHROMA_QUANT, quality);
  const tables = {
    dcLuma: codesFor(DC_LUMA),
    acLuma: codesFor(AC_LUMA),
    dcChroma: codesFor(DC_CHROMA),
    acChroma: codesFor(AC_CHROMA),
  };
  const planes = [0, 1, 2].map(() => new Float32Array(width * height));
  for (let index = 0; index < width * height; index++) {
    const r = data[index * 3];
    const g = data[index * 3 + 1];
    const b = data[index * 3 + 2];
    planes[0][index] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    planes[1][index] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    planes[2][index] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  const writer = new BitWriter();
  const block = new Float64Array(64);
  const rows = new Float64Array(64);
  const coefficients = new Int32Array(64);
  const previous = [0, 0, 0];
  const sample = (plane: Float32Array, x: number, y: number) =>
    plane[Math.min(height - 1, y) * width + Math.min(width - 1, x)];
  const emit = (codes: Codes, symbol: number) =>
    writer.write(codes.code[symbol], codes.length[symbol]);
  const magnitude = (value: number) => {
    let size = 0;
    for (let abs = Math.abs(value); abs; abs >>= 1) size++;
    return size;
  };
  const bits = (value: number, size: number) =>
    writer.write(value < 0 ? value + (1 << size) - 1 : value, size);
  const encodeBlock = (
    component: number,
    quant: number[],
    dc: Codes,
    ac: Codes,
  ) => {
    // Rows first, then columns: block[v*8+u] ends up holding coefficient (v, u).
    for (let y = 0; y < 8; y++)
      for (let u = 0; u < 8; u++) {
        let sum = 0;
        for (let x = 0; x < 8; x++) sum += BASIS[u * 8 + x] * block[y * 8 + x];
        rows[y * 8 + u] = sum;
      }
    for (let v = 0; v < 8; v++)
      for (let u = 0; u < 8; u++) {
        let sum = 0;
        for (let y = 0; y < 8; y++) sum += BASIS[v * 8 + y] * rows[y * 8 + u];
        coefficients[v * 8 + u] = Math.round(sum / quant[v * 8 + u]);
      }
    const diff = coefficients[0] - previous[component];
    previous[component] = coefficients[0];
    const dcSize = magnitude(diff);
    emit(dc, dcSize);
    if (dcSize) bits(diff, dcSize);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const value = coefficients[ZIGZAG[k]];
      if (!value) {
        run++;
        continue;
      }
      while (run > 15) {
        emit(ac, 0xf0);
        run -= 16;
      }
      const size = magnitude(value);
      emit(ac, (run << 4) | size);
      bits(value, size);
      run = 0;
    }
    if (run) emit(ac, 0x00);
  };
  for (let my = 0; my < height; my += 16)
    for (let mx = 0; mx < width; mx += 16) {
      for (const [ox, oy] of [
        [0, 0],
        [8, 0],
        [0, 8],
        [8, 8],
      ]) {
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            block[y * 8 + x] = sample(planes[0], mx + ox + x, my + oy + y);
        encodeBlock(0, lumaQuant, tables.dcLuma, tables.acLuma);
      }
      for (const component of [1, 2]) {
        const plane = planes[component];
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const px = mx + x * 2;
            const py = my + y * 2;
            block[y * 8 + x] =
              (sample(plane, px, py) +
                sample(plane, px + 1, py) +
                sample(plane, px, py + 1) +
                sample(plane, px + 1, py + 1)) /
              4;
          }
        encodeBlock(component, chromaQuant, tables.dcChroma, tables.acChroma);
      }
    }
  const scan = writer.finish();

  const out: number[] = [];
  const word = (value: number) => out.push((value >> 8) & 0xff, value & 0xff);
  const segment = (marker: number, body: number[]) => {
    out.push(0xff, marker);
    word(body.length + 2);
    out.push(...body);
  };
  out.push(0xff, 0xd8);
  segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  segment(0xdb, [
    0,
    ...ZIGZAG.map((index) => lumaQuant[index]),
    1,
    ...ZIGZAG.map((index) => chromaQuant[index]),
  ]);
  segment(0xc0, [
    8,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
  segment(0xc4, [
    0x00,
    ...DC_LUMA.counts,
    ...DC_LUMA.symbols,
    0x10,
    ...AC_LUMA.counts,
    ...AC_LUMA.symbols,
    0x01,
    ...DC_CHROMA.counts,
    ...DC_CHROMA.symbols,
    0x11,
    ...AC_CHROMA.counts,
    ...AC_CHROMA.symbols,
  ]);
  segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  const header = Buffer.from(out);
  return Buffer.concat([header, Buffer.from(scan), Buffer.from([0xff, 0xd9])]);
}

/** A replay keyframe from a screenshot PNG: at most `maxWidth` wide, JPEG at `quality`. */
export function keyframeFromPng(
  png: Uint8Array,
  maxWidth = 1024,
  quality = 60,
): Buffer {
  return encodeJpeg(shrink(decodePng(png), maxWidth), quality);
}
