export const TEXTURE_SIZE = 16;

export const rgb = (hex) => {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >>> 16) & 255, (value >>> 8) & 255, value & 255];
};

export const shift = (color, amount) =>
  color.map((value) => Math.max(0, Math.min(255, value + amount)));

export function noise(x, y, seed) {
  let n =
    Math.imul(x + seed * 43, 374761393) + Math.imul(y + seed * 17, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

const wrap = (value, size) => ((value % size) + size) % size;
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

// Periodic, connected value regions, not independent pixels or square cells.
export function grain(x, y, seed, columns = 4, rows = columns) {
  const u = ((x + 0.5) * columns) / TEXTURE_SIZE;
  const v = ((y + 0.5) * rows) / TEXTURE_SIZE;
  const ix = Math.floor(u);
  const iy = Math.floor(v);
  const sample = (dx, dy) =>
    noise(wrap(ix + dx, columns), wrap(iy + dy, rows), seed);
  return mix(
    mix(sample(0, 0), sample(1, 0), smooth(u - ix)),
    mix(sample(0, 1), sample(1, 1), smooth(u - ix)),
    smooth(v - iy)
  );
}

export function painter(pixels) {
  const rect = (x, y, width, height, color) => {
    const channels = typeof color === "string" ? rgb(color) : color;
    for (
      let py = Math.max(0, y);
      py < Math.min(TEXTURE_SIZE, y + height);
      py++
    ) {
      for (
        let px = Math.max(0, x);
        px < Math.min(TEXTURE_SIZE, x + width);
        px++
      ) {
        const at = (py * TEXTURE_SIZE + px) * 4;
        pixels.set([...channels.slice(0, 3), channels[3] ?? 255], at);
      }
    }
  };
  const line = (x0, y0, x1, y1, color, width = 1) => {
    const length = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= length; i++) {
      rect(
        Math.round(x0 + ((x1 - x0) * i) / length),
        Math.round(y0 + ((y1 - y0) * i) / length),
        width,
        width,
        color
      );
    }
  };
  const stamp = (x, y, pattern, palette, tiled = false) => {
    for (let dy = 0; dy < pattern.length; dy++) {
      for (let dx = 0; dx < pattern[dy].length; dx++) {
        const ink = pattern[dy][dx];
        if (ink === ".") continue;
        rect(
          tiled ? wrap(x + dx, TEXTURE_SIZE) : x + dx,
          tiled ? wrap(y + dy, TEXTURE_SIZE) : y + dy,
          1,
          1,
          palette[Number(ink)]
        );
      }
    }
  };
  const field = (palette, seed, columns = 4, rows = columns) => {
    for (let y = 0; y < TEXTURE_SIZE; y++) {
      for (let x = 0; x < TEXTURE_SIZE; x++) {
        const tone = Math.min(
          palette.length - 1,
          Math.floor(grain(x, y, seed, columns, rows) * palette.length)
        );
        rect(x, y, 1, 1, palette[tone]);
      }
    }
  };
  return { rect, line, stamp, field };
}
