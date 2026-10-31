// Draws the extension icons with no dependencies. Run: node scripts/make-icons.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4;
const BACKGROUND = [11, 122, 117];
const FOREGROUND = [255, 255, 255];

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundedSquare(x, y, radius) {
  const dx = Math.max(radius - x, x - (1 - radius), 0);
  const dy = Math.max(radius - y, y - (1 - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

function nearSegment(x, y, [ax, ay], [bx, by], width) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= width / 2;
}

// A terminal prompt: the chevron and cursor say "this ends in a script".
function insideGlyph(x, y) {
  const width = 0.13;
  return nearSegment(x, y, [0.26, 0.28], [0.5, 0.5], width)
    || nearSegment(x, y, [0.5, 0.5], [0.26, 0.72], width)
    || nearSegment(x, y, [0.54, 0.72], [0.76, 0.72], width);
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let shape = 0;
      let glyph = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!insideRoundedSquare(x, y, 0.2)) continue;
          shape += 1;
          if (insideGlyph(x, y)) glyph += 1;
        }
      }
      const offset = (py * size + px) * 4;
      const mix = shape ? glyph / shape : 0;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = BACKGROUND[channel] * (1 - mix) + FOREGROUND[channel] * mix;
      }
      pixels[offset + 3] = (shape / (SAMPLES * SAMPLES)) * 255;
    }
  }
  return pixels;
}

mkdirSync('icons', { recursive: true });
for (const size of SIZES) writeFileSync(`icons/icon-${size}.png`, encodePng(size, draw(size)));
