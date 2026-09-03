import {
  createPlayerRig,
  getPlayerEquipmentItem,
  getPlayerStackItem,
  posePlayerRig,
} from "./player-rig.js";
import { PLAYER_SKINS, paintPlayerSkinFace } from "./player-skin.js";

// Twice the inventory's 35 x 68 logical-pixel inset. CSS may scale this bitmap.
export const PLAYER_PORTRAIT_WIDTH = 70;
export const PLAYER_PORTRAIT_HEIGHT = 136;
export const MAX_PLAYER_PORTRAIT_SIZE = 256;
const EMPTY = Object.freeze({});
const EQUIPMENT = Object.freeze(["head", "chest", "legs", "feet"]);

// Unit-cube top-left, right and down vectors in the exact BoxGeometry face/UV
// order used by the shared skin shader: right, left, top, bottom, front, back.
const PLANES = [
  [0.5, 0.5, 0.5, 0, 0, -1, 0, -1, 0],
  [-0.5, 0.5, -0.5, 0, 0, 1, 0, -1, 0],
  [-0.5, 0.5, -0.5, 1, 0, 0, 0, 0, 1],
  [-0.5, -0.5, 0.5, 1, 0, 0, 0, 0, -1],
  [-0.5, 0.5, 0.5, 1, 0, 0, 0, -1, 0],
  [0.5, 0.5, -0.5, -1, 0, 0, 0, -1, 0],
];

let skinFaces;
let linearBytes;
function sharedSkinFaces() {
  if (!skinFaces) {
    // Only the fixed shared catalog, never a cache keyed by item/state/world.
    skinFaces = new Map();
    for (const skin of Object.values(PLAYER_SKINS))
      skinFaces.set(
        skin,
        Array.from({ length: 6 }, (_, face) => paintPlayerSkinFace(skin, face))
      );
    linearBytes = new Float64Array(256);
    for (let byte = 0; byte < 256; byte++) {
      const value = byte / 255;
      linearBytes[byte] =
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }
  }
  return skinFaces;
}

function colorByte(linear) {
  const value =
    linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function validSize(value) {
  return (
    Number.isInteger(value) && value >= 16 && value <= MAX_PLAYER_PORTRAIT_SIZE
  );
}

function projectFace(target, matrix, plane, view, shading) {
  const m = matrix.elements;
  const x = m[0] * plane[0] + m[4] * plane[1] + m[8] * plane[2] + m[12];
  const y =
    m[1] * plane[0] + m[5] * plane[1] + m[9] * plane[2] + m[13] - view.originY;
  const z = m[2] * plane[0] + m[6] * plane[1] + m[10] * plane[2] + m[14];
  const ux = m[0] * plane[3] + m[4] * plane[4] + m[8] * plane[5];
  const uy = m[1] * plane[3] + m[5] * plane[4] + m[9] * plane[5];
  const uz = m[2] * plane[3] + m[6] * plane[4] + m[10] * plane[5];
  const vx = m[0] * plane[6] + m[4] * plane[7] + m[8] * plane[8];
  const vy = m[1] * plane[6] + m[5] * plane[7] + m[9] * plane[8];
  const vz = m[2] * plane[6] + m[6] * plane[7] + m[10] * plane[8];
  target.x = view.centerX + view.scale * x;
  target.y = view.centerY - view.scale * (view.cosine * y - view.sine * z);
  target.z = view.sine * y + view.cosine * z;
  target.ux = view.scale * ux;
  target.uy = -view.scale * (view.cosine * uy - view.sine * uz);
  target.uz = view.sine * uy + view.cosine * uz;
  target.vx = view.scale * vx;
  target.vy = -view.scale * (view.cosine * vy - view.sine * vz);
  target.vz = view.sine * vy + view.cosine * vz;
  // Cross down/right gives the outward normal, including nonuniform scales.
  const nx = vy * uz - vz * uy;
  const ny = vz * ux - vx * uz;
  const nz = vx * uy - vy * ux;
  const light =
    (-nx + 2 * ny + 3 * nz) / Math.hypot(nx, ny, nz) / Math.sqrt(14);
  target.light = shading ? 0.72 + 0.28 * Math.max(0, light) : 1;
}

function rasterizeFace(pixels, depths, face, image, tint) {
  const determinant = face.ux * face.vy - face.uy * face.vx;
  if (determinant <= 1e-10) return; // Back face or edge-on, like FrontSide.
  const minX = Math.max(
    0,
    Math.floor(face.x + Math.min(0, face.ux) + Math.min(0, face.vx))
  );
  const maxX = Math.min(
    pixels.width,
    Math.ceil(face.x + Math.max(0, face.ux) + Math.max(0, face.vx))
  );
  const minY = Math.max(
    0,
    Math.floor(face.y + Math.min(0, face.uy) + Math.min(0, face.vy))
  );
  const maxY = Math.min(
    pixels.height,
    Math.ceil(face.y + Math.max(0, face.uy) + Math.max(0, face.vy))
  );
  const red = tint.r * face.light;
  const green = tint.g * face.light;
  const blue = tint.b * face.light;
  for (let y = minY; y < maxY; y++) {
    const dy = y + 0.5 - face.y;
    for (let x = minX; x < maxX; x++) {
      const dx = x + 0.5 - face.x;
      const u = (dx * face.vy - dy * face.vx) / determinant;
      const v = (face.ux * dy - face.uy * dx) / determinant;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const depth = face.z + u * face.uz + v * face.vz;
      const index = y * pixels.width + x;
      // Coplanar armor overlaps keep the first part. Ignore only roundoff in
      // this bounded, local-rig depth, not differences in surface coverage/UVs.
      if (depth <= depths[index] + 1e-12) continue;
      depths[index] = depth;
      const texel =
        (Math.floor(v * image.height) * image.width +
          Math.floor(u * image.width)) *
        4;
      const offset = index * 4;
      pixels.data[offset] = colorByte(linearBytes[image.data[texel]] * red);
      pixels.data[offset + 1] = colorByte(
        linearBytes[image.data[texel + 1]] * green
      );
      pixels.data[offset + 2] = colorByte(
        linearBytes[image.data[texel + 2]] * blue
      );
      // Source alpha is an emission mask. Every hit is an opaque surface.
      pixels.data[offset + 3] = 255;
    }
  }
}

/**
 * A standing inventory portrait of the actual player rig, without a renderer,
 * animation loop or GPU resources. canvas may be null for the pure pixel API.
 *
 * update({ mainHand, offhand, equipment }, { visible: true }) returns whether
 * pixels/canvas changed. Stacks are read-only; only appearance changes redraw,
 * not stack amounts, wear, world position, world yaw or F5 perspective.
 *
 * pixels is a borrowed, reusable { width, height, data: Uint8ClampedArray }
 * (sRGB RGBA, transparent background, opaque nearest-sampled surfaces).
 * yaw/elevation are fixed portrait-view radians, not physical player angles.
 * Dispose when the owning inventory is destroyed, not every time it closes.
 */
export class PlayerPortrait {
  constructor(
    canvas = null,
    {
      width = PLAYER_PORTRAIT_WIDTH,
      height = PLAYER_PORTRAIT_HEIGHT,
      yaw = -0.2,
      elevation = 0.1,
      shading = true,
    } = EMPTY
  ) {
    if (!validSize(width) || !validSize(height))
      throw new RangeError(
        "Player portrait dimensions must be integers from 16 to 256"
      );
    if (!Number.isFinite(yaw) || !Number.isFinite(elevation))
      throw new RangeError("Player portrait angles must be finite");
    this.width = width;
    this.height = height;
    this.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    const angle = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, elevation));
    this.projection = Object.freeze({
      centerX: width / 2,
      centerY: height / 2,
      originY: 0.9,
      scale: Math.min(width / 1.3, height / 2.25),
      cosine: Math.cos(angle),
      sine: Math.sin(angle),
    });
    this.shading = Boolean(shading);
    this.canvas = canvas;
    this.pixels = null;
    this.revision = 0;
    this.disposed = false;
    this._rig = null;
    this._depths = null;
    this._face = {};
    this._items = Array(6).fill(null);
    this._nextItems = Array(6).fill(null);
    this._context = null;
    this._imageData = null;
  }

  update(state = EMPTY, { visible = true } = EMPTY) {
    if (this.disposed || !visible) return false;
    this._nextItems[0] = getPlayerStackItem(state?.mainHand);
    this._nextItems[1] = getPlayerStackItem(state?.offhand);
    for (let i = 0; i < EQUIPMENT.length; i++)
      this._nextItems[i + 2] = getPlayerEquipmentItem(
        EQUIPMENT[i],
        state?.equipment?.[EQUIPMENT[i]]
      );
    let changed = this.pixels === null;
    for (let i = 0; i < this._items.length; i++)
      if (this._items[i] !== this._nextItems[i]) changed = true;
    const resized =
      this.canvas &&
      (this.canvas.width !== this.width || this.canvas.height !== this.height);
    if (!changed && !resized) return false;
    if (changed) {
      this._render(state);
      for (let i = 0; i < this._items.length; i++)
        this._items[i] = this._nextItems[i];
      this.revision++;
    }
    return this._paint() || changed;
  }

  _render(state) {
    if (!this.pixels) {
      this.pixels = Object.freeze({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(this.width * this.height * 4),
      });
      this._depths = new Float64Array(this.width * this.height);
      this._rig = createPlayerRig();
    }
    // Inventory framing is independent of world/camera pose. This temporary
    // read-only bridge is not retained as another inventory state authority.
    posePlayerRig(this._rig, 0, {
      yaw: this.yaw - Math.PI,
      mainHand: state?.mainHand,
      offhand: state?.offhand,
      equipment: state?.equipment,
    });
    this.pixels.data.fill(0);
    this._depths.fill(-Infinity);
    const skins = sharedSkinFaces();
    for (const part of this._rig.parts) {
      if (!part.visible) continue;
      const images = skins.get(part.skin);
      if (!images) throw new Error("Unregistered player portrait skin");
      for (let index = 0; index < PLANES.length; index++) {
        projectFace(
          this._face,
          part.node.matrixWorld,
          PLANES[index],
          this.projection,
          this.shading
        );
        rasterizeFace(
          this.pixels,
          this._depths,
          this._face,
          images[index],
          part.color
        );
      }
    }
  }

  _paint() {
    if (!this.canvas) return false;
    this._context ??= this.canvas.getContext?.("2d") ?? null;
    if (!this._context) return false;
    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;
    this._imageData ??= this._context.createImageData(this.width, this.height);
    this._imageData.data.set(this.pixels.data);
    this._context.imageSmoothingEnabled = false;
    if (this.canvas.style) this.canvas.style.imageRendering = "pixelated";
    this._context.putImageData(this._imageData, 0, 0);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas = this._context = this._imageData = null;
    this.pixels = this._depths = this._rig = null;
    this._items.fill(null);
    this._nextItems.fill(null);
  }
}

/** One-shot CPU pixel API. Prefer one PlayerPortrait instance for live UI. */
export function renderPlayerPortrait(state = EMPTY, options = EMPTY) {
  const portrait = new PlayerPortrait(null, options);
  portrait.update(state);
  const pixels = portrait.pixels;
  portrait.dispose();
  return pixels;
}
