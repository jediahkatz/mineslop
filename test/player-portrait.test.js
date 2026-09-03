import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as THREE from "three";
import { ITEM } from "../src/items.js";
import {
  MAX_PLAYER_PORTRAIT_SIZE,
  PlayerPortrait,
  renderPlayerPortrait,
} from "../src/player-portrait.js";
import { createPlayerRig, posePlayerRig } from "../src/player-rig.js";
import {
  getPlayerSkinAtlasData,
  PLAYER_SKINS,
  paintPlayerSkinFace,
} from "../src/player-skin.js";

const stack = (id, durability) =>
  durability === undefined ? { id, count: 1 } : { id, count: 1, durability };
const equipped = () => ({
  mainHand: stack(ITEM.IRON_PICKAXE),
  offhand: stack(ITEM.SHIELD),
  equipment: {
    head: stack(ITEM.IRON_HELMET),
    chest: stack(ITEM.IRON_ARMOR),
    legs: stack(ITEM.IRON_LEGGINGS),
    feet: stack(ITEM.IRON_BOOTS),
  },
});
const digest = (data) => createHash("sha256").update(data).digest("hex");
const pixel = (image, x, y) => [
  ...image.data.subarray(
    (y * image.width + x) * 4,
    (y * image.width + x) * 4 + 4
  ),
];

function canvasFixture() {
  const calls = { context: 0, image: 0, paint: 0 };
  const context = {
    imageSmoothingEnabled: true,
    createImageData(width, height) {
      calls.image++;
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image, x, y) {
      calls.paint++;
      assert.equal(x, 0);
      assert.equal(y, 0);
      this.lastImage = image;
    },
  };
  const canvas = {
    width: 300,
    height: 150,
    style: {},
    getContext(kind) {
      assert.equal(kind, "2d", "no WebGL context is requested");
      calls.context++;
      return context;
    },
  };
  return { canvas, context, calls };
}

// Independent reference: raycast the actual shared rig with Three's own box
// triangles/UVs. This does not use the portrait's face planes or rasterizer.
function reference(t, state, portrait) {
  const rig = createPlayerRig();
  posePlayerRig(rig, 0, { ...state, yaw: portrait.yaw - Math.PI });
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  t.after(() => {
    geometry.dispose();
    material.dispose();
  });
  const meshes = rig.parts
    .filter((part) => part.visible)
    .map((part, order) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(part.node.matrixWorld);
      mesh.updateMatrixWorld(true);
      mesh.userData.part = part;
      mesh.userData.order = order;
      return mesh;
    });
  const ray = new THREE.Raycaster();
  const tint = new THREE.Color();
  const faces = new Map();
  const view = portrait.projection;
  return (x, y) => {
    const horizontal = (x + 0.5 - view.centerX) / view.scale;
    const vertical = (view.centerY - y - 0.5) / view.scale;
    ray.ray.origin.set(
      horizontal,
      view.originY + vertical * view.cosine + 8 * view.sine,
      -vertical * view.sine + 8 * view.cosine
    );
    ray.ray.direction.set(0, -view.sine, -view.cosine);
    const hits = ray.intersectObjects(meshes, false);
    let hit = hits[0];
    // Coincident armor surfaces have different UVs. Match the first-part tie
    // policy without trusting roundoff in Three's distance sort or skipping
    // pixels/accepting alternate colors. Geometry and UVs still come from Three.
    for (const candidate of hits) {
      if (candidate.distance > hits[0].distance + 1e-12) break;
      if (candidate.object.userData.order < hit.object.userData.order)
        hit = candidate;
    }
    if (!hit) return { rgba: [0, 0, 0, 0], part: null };
    const part = hit.object.userData.part;
    const face = Math.floor(hit.faceIndex / 2);
    const key = `${part.skin.key}/${face}`;
    if (!faces.has(key)) faces.set(key, paintPlayerSkinFace(part.skin, face));
    const source = faces.get(key);
    const sx = Math.max(
      0,
      Math.min(source.width - 1, Math.floor(hit.uv.x * source.width))
    );
    const sy = Math.max(
      0,
      Math.min(source.height - 1, Math.floor((1 - hit.uv.y) * source.height))
    );
    const texel = pixel(source, sx, sy);
    assert.equal(texel[3], 0, "shared skin alpha remains the emission mask");
    tint
      .setRGB(
        texel[0] / 255,
        texel[1] / 255,
        texel[2] / 255,
        THREE.SRGBColorSpace
      )
      .multiply(part.color)
      .convertLinearToSRGB();
    return {
      part,
      hit,
      hits,
      rgba: [
        Math.round(tint.r * 255),
        Math.round(tint.g * 255),
        Math.round(tint.b * 255),
        255,
      ],
    };
  };
}

test("portrait pixels are deterministic, opaque on the human, and preserve shared skin bytes", () => {
  const atlas = getPlayerSkinAtlasData();
  const before = atlas.data.slice();
  const first = renderPlayerPortrait();
  const second = renderPlayerPortrait();
  assert.ok(first.data instanceof Uint8ClampedArray);
  assert.equal(first.data.length, first.width * first.height * 4);
  assert.notEqual(first.data, second.data);
  assert.deepEqual(first.data, second.data);
  const alpha = new Set();
  for (let i = 3; i < first.data.length; i += 4) alpha.add(first.data[i]);
  assert.deepEqual(alpha, new Set([0, 255]));
  assert.deepEqual(atlas.data, before);
  const head = paintPlayerSkinFace(PLAYER_SKINS.head, "front");
  for (let i = 3; i < head.data.length; i += 4) assert.equal(head.data[i], 0);
});

test("portrait matches actual rig geometry, nearest skin UVs and armor occlusion", (t) => {
  const roles = new Set();
  const views = [
    [{}, -0.27, 0.17],
    [equipped(), -0.27, 0.17],
    [{ mainHand: stack(ITEM.STONE), offhand: stack(ITEM.BOW) }, 0.37, -0.19],
  ];
  for (const [state, yaw, elevation] of views) {
    const portrait = new PlayerPortrait(null, {
      yaw,
      elevation,
      shading: false,
    });
    t.after(() => portrait.dispose());
    portrait.update(state);
    const expectedAt = reference(t, state, portrait);
    for (let y = 0; y < portrait.height; y++) {
      for (let x = 0; x < portrait.width; x++) {
        const expected = expectedAt(x, y);
        assert.deepEqual(
          pixel(portrait.pixels, x, y),
          expected.rgba,
          `${expected.part?.node.name ?? "background"} at ${x},${y}`
        );
        if (expected.part) roles.add(expected.part.skin.role);
      }
    }
    assert.ok(portrait._rig.parts.every((part) => !part.node.isMesh));
  }
  for (const role of [
    "head",
    "coat",
    "trousers",
    "boot",
    "metal",
    "wood",
    "tint",
  ])
    assert.ok(roles.has(role), `${role} is sampled from the real model`);
});

test("coplanar armor overlaps consistently keep the first rig part", (t) => {
  const state = equipped();
  const portrait = new PlayerPortrait(null, {
    yaw: -0.27,
    elevation: 0.17,
    shading: false,
  });
  t.after(() => portrait.dispose());
  portrait.update(state);
  const expectedAt = reference(t, state, portrait);
  // Regression pixels: adjacent parts occupy the same point, not adjacent
  // texels of one part. Previously roundoff selected inconsistent winners.
  for (const [x, y, first, second] of [
    [27, 94, "right-leg-armor", "right-shin-armor"],
    [28, 94, "right-leg-armor", "right-shin-armor"],
    [29, 94, "right-leg-armor", "right-shin-armor"],
    [47, 94, "left-leg-armor", "left-shin-armor"],
    [33, 109, "right-boot-armor", "left-boot-armor"],
  ]) {
    const expected = expectedAt(x, y);
    const nearest = expected.hits[0].distance;
    const coincident = expected.hits.filter(
      (hit) => hit.distance <= nearest + 1e-12
    );
    assert.deepEqual(
      coincident.map((hit) => hit.object.userData.part.node.name).sort(),
      [first, second].sort()
    );
    assert.ok(coincident[0].point.distanceTo(coincident[1].point) < 1e-12);
    assert.equal(expected.part.node.name, first);
    assert.deepEqual(pixel(portrait.pixels, x, y), expected.rgba);
    assert.ok(
      expected.hits.some((hit) => hit.distance > nearest + 1e-6),
      "genuinely occluded surfaces are not part of the coplanar tie"
    );
  }
});

test("front and back use their real face texels, not a copied front billboard", (t) => {
  const images = [];
  for (const yaw of [0, Math.PI]) {
    const portrait = new PlayerPortrait(null, {
      yaw,
      elevation: 0,
      shading: false,
    });
    t.after(() => portrait.dispose());
    portrait.update({});
    const expectedAt = reference(t, {}, portrait);
    const x = Math.floor(portrait.width / 2);
    for (let y = 19; y < 45; y += 4)
      assert.deepEqual(pixel(portrait.pixels, x, y), expectedAt(x, y).rgba);
    images.push(digest(portrait.pixels.data));
  }
  assert.notEqual(images[0], images[1]);
});

test("each supplied hand and equipment slot changes the portrait without mutating input", (t) => {
  const portrait = new PlayerPortrait();
  t.after(() => portrait.dispose());
  portrait.update({});
  const bare = digest(portrait.pixels.data);
  for (const slot of ["head", "chest", "legs", "feet"]) {
    const equipment = Object.freeze({
      [slot]: Object.freeze(equipped().equipment[slot]),
    });
    const state = Object.freeze({ equipment });
    const before = structuredClone(state);
    assert.equal(portrait.update(state), true);
    assert.notEqual(digest(portrait.pixels.data), bare, slot);
    assert.deepEqual(state, before);
    assert.equal(portrait.update({}), true);
    assert.equal(digest(portrait.pixels.data), bare);
  }
  for (const hand of ["mainHand", "offhand"]) {
    const state = Object.freeze({
      [hand]: Object.freeze(stack(ITEM.DIAMOND_SWORD)),
    });
    const before = structuredClone(state);
    assert.equal(portrait.update(state), true);
    assert.notEqual(digest(portrait.pixels.data), bare, hand);
    assert.deepEqual(state, before);
    portrait.update({});
    assert.equal(digest(portrait.pixels.data), bare);
  }
});

test("only visible appearance changes redraw; in-place edits, invalidation and wear are safe", (t) => {
  const portrait = new PlayerPortrait();
  t.after(() => portrait.dispose());
  const unreadable = new Proxy(
    {},
    {
      get() {
        throw new Error("hidden portraits must not inspect state");
      },
    }
  );
  assert.equal(portrait.update(unreadable, { visible: false }), false);
  assert.equal(portrait.pixels, null);
  assert.equal(portrait._rig, null);
  const state = {
    mainHand: { id: ITEM.STONE, count: 2 },
    offhand: stack(ITEM.BOW, 41),
    equipment: { head: stack(ITEM.IRON_HELMET, 31) },
  };
  assert.equal(portrait.update(state), true);
  const data = portrait.pixels.data;
  const rig = portrait._rig;
  const depths = portrait._depths;
  const items = portrait._items;
  const nextItems = portrait._nextItems;
  const revision = portrait.revision;
  const before = digest(data);
  state.mainHand.count = 23;
  state.offhand.durability = 30;
  state.equipment.head.durability = 20;
  state.position = { x: 29_000_000.375, y: 9, z: -29_000_000.625 };
  state.yaw = 170;
  state.perspective = "first";
  assert.equal(portrait.update(state), false);
  assert.equal(portrait.update(structuredClone(state)), false);
  assert.equal(portrait.revision, revision);
  assert.equal(digest(data), before);
  state.offhand.id = ITEM.SHIELD;
  assert.equal(portrait.update(state, { visible: false }), false);
  assert.equal(portrait.revision, revision);
  assert.equal(portrait.update(state), true);
  assert.equal(portrait.revision, revision + 1);
  assert.notEqual(digest(data), before);
  state.equipment.head.id = ITEM.IRON_ARMOR; // Not a helmet.
  assert.equal(portrait.update(state), true);
  assert.equal(portrait._rig.equipment.head.item, null);
  state.mainHand.count = 0;
  assert.equal(portrait.update(state), true);
  assert.equal(portrait._rig.mainHand.item, null);
  state.mainHand = { id: 999_999, count: 1 };
  assert.equal(
    portrait.update(state),
    false,
    "invalid -> invalid has no appearance change"
  );
  for (let i = 0; i < 8; i++) {
    state.mainHand = stack(i % 2 ? ITEM.APPLE : ITEM.BOW);
    portrait.update(state);
    assert.equal(portrait.pixels.data, data);
    assert.equal(portrait._rig, rig);
    assert.equal(portrait._depths, depths);
    assert.equal(portrait._items, items);
    assert.equal(portrait._nextItems, nextItems);
    assert.equal(items.length, 6, "fixed appearance key, no per-item cache");
  }
});

test("Canvas2D paints lazily, keeps pixel sampling, and reuses ImageData through resize", (t) => {
  const { canvas, context, calls } = canvasFixture();
  const portrait = new PlayerPortrait(canvas);
  t.after(() => portrait.dispose());
  assert.equal(portrait.update({}, { visible: false }), false);
  assert.deepEqual(calls, { context: 0, image: 0, paint: 0 });
  assert.equal(portrait.update({}), true);
  assert.equal(canvas.width, portrait.width);
  assert.equal(canvas.height, portrait.height);
  assert.equal(context.imageSmoothingEnabled, false);
  assert.equal(canvas.style.imageRendering, "pixelated");
  const image = context.lastImage;
  assert.deepEqual(image.data, portrait.pixels.data);
  assert.equal(portrait.update({}), false);
  assert.deepEqual(calls, { context: 1, image: 1, paint: 1 });
  const revision = portrait.revision;
  canvas.width = 1;
  assert.equal(portrait.update({}), true);
  assert.equal(portrait.revision, revision, "resize repaints cached pixels");
  assert.equal(context.lastImage, image);
  assert.equal(canvas.width, portrait.width);
  assert.equal(portrait.update(equipped()), true);
  assert.equal(context.lastImage, image);
  assert.deepEqual(image.data, portrait.pixels.data);
  assert.deepEqual(calls, { context: 1, image: 1, paint: 3 });
});

test("dimensions are bounded and disposal releases the owned portrait buffers", () => {
  for (const invalid of [
    0,
    -1,
    15,
    17.5,
    NaN,
    Infinity,
    MAX_PLAYER_PORTRAIT_SIZE + 1,
  ]) {
    assert.throws(
      () => new PlayerPortrait(null, { width: invalid }),
      /dimensions/
    );
    assert.throws(
      () => new PlayerPortrait(null, { height: invalid }),
      /dimensions/
    );
  }
  assert.throws(() => new PlayerPortrait(null, { yaw: NaN }), /finite/);
  assert.throws(
    () => new PlayerPortrait(null, { elevation: Infinity }),
    /finite/
  );
  const first = new PlayerPortrait(null, { width: 48, height: 96 });
  const second = new PlayerPortrait(null, { width: 48, height: 96 });
  first.update(equipped());
  second.update(equipped());
  assert.equal(first.pixels.data.length, 48 * 96 * 4);
  assert.notEqual(first.pixels.data, second.pixels.data);
  assert.deepEqual(first.pixels.data, second.pixels.data);
  first.dispose();
  first.dispose();
  assert.equal(first.pixels, null);
  assert.equal(first._depths, null);
  assert.equal(first._rig, null);
  assert.equal(first._imageData, null);
  assert.equal(first._context, null);
  assert.equal(first.update({}), false);
  assert.equal(second.update({}), true);
  assert.ok(second.pixels.data.some((value) => value !== 0));
  second.dispose();
});
