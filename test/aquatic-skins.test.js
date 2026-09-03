import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAquaticModel } from "../src/aquatic-models.js";
import {
  AQUATIC_KINDS,
  AQUATIC_SKIN_ART_SIZE,
  AQUATIC_SKIN_ROLES,
  createAquaticSkin,
  paintAquaticSkinFace,
} from "../src/aquatic-skins.js";
import {
  getMobSkinAtlasData,
  MAX_MOB_SKINS,
  MOB_SKIN_ATLAS_SIZE,
  mobSkinFaceRect,
  mobSkinTileSize,
} from "../src/mob-skin-atlas.js";
import {
  MOB_SKIN_FACES,
  MOB_TEXELS_PER_BLOCK,
  mobSkinFaceSize,
} from "../src/mob-skins.js";

const models = AQUATIC_KINDS.map(createAquaticModel);
const skins = [
  ...new Map(
    models.flatMap((model) =>
      model.parts.map((part) => [part.skin.key, part.skin])
    )
  ).values(),
];
const digest = (image) => createHash("sha256").update(image.data).digest("hex");

function pixel(image, x, y) {
  const start = (y * image.width + x) * 4;
  return [...image.data.subarray(start, start + 4)];
}

function luminance([r, g, b]) {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function facePart(model) {
  return model.parts.find(
    (part) => part.role === "head" || part.role === "eye"
  );
}

function emissionCount(image) {
  let count = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 0) count++;
  return count;
}

test("every aquatic skin is deterministic original art with atlas-compatible physical dimensions", () => {
  const faces = new Set();
  for (const skin of skins) {
    assert.equal(skin.family, "aquatic");
    assert.ok(Object.isFrozen(skin));
    assert.ok(Object.isFrozen(skin.pixels));
    assert.equal(skin.tintable, false);
    assert.equal(skin.translucent, false);
    for (const [index, face] of MOB_SKIN_FACES.entries()) {
      const image = paintAquaticSkinFace(skin, face);
      assert.ok(image.data instanceof Uint8Array);
      assert.deepEqual(
        [image.width, image.height],
        mobSkinFaceSize(skin, index)
      );
      assert.equal(image.data.length, image.width * image.height * 4);
      assert.deepEqual(image, paintAquaticSkinFace(skin, index));
      assert.deepEqual(image, paintAquaticSkinFace(skin, face));
    }
  }
  for (const model of models) {
    const skin = facePart(model).skin;
    const front = paintAquaticSkinFace(skin, "front");
    assert.notEqual(digest(front), digest(paintAquaticSkinFace(skin, "back")));
    faces.add(digest(front));
    for (const role of AQUATIC_SKIN_ROLES[model.kind]) {
      const side = AQUATIC_SKIN_ART_SIZE / MOB_TEXELS_PER_BLOCK;
      const art = createAquaticSkin(model.kind, role, [side, side, side]);
      for (const face of MOB_SKIN_FACES) {
        const image = paintAquaticSkinFace(art, face);
        assert.deepEqual(
          [image.width, image.height],
          [AQUATIC_SKIN_ART_SIZE, AQUATIC_SKIN_ART_SIZE]
        );
        assert.ok(image.data.some((value) => value > 0));
      }
    }
  }
  assert.equal(
    faces.size,
    models.length,
    "not one generic face in five colors"
  );
});

test("both animal eyes and the drowned's separated sockets survive small physical head grids", () => {
  for (const kind of ["dolphin", "turtle", "drowned"]) {
    const model = models.find((entry) => entry.kind === kind);
    const image = paintAquaticSkinFace(facePart(model).skin, "front");
    const row = Math.floor(image.height * 0.375);
    const eyes = new Set();
    for (let x = 0; x < image.width; x++)
      if (luminance(pixel(image, x, row)) < 75)
        eyes.add(x < image.width / 2 ? "left" : "right");
    assert.equal(eyes.size, 2, `${kind}: both inset eyes remain readable`);
    assert.ok(
      luminance(pixel(image, Math.floor(image.width / 2), row)) > 85,
      `${kind}: the two eyes do not merge into one band`
    );
  }
});

test("dolphin and turtle side eyes face the snout on both cube orientations", () => {
  for (const kind of ["dolphin", "turtle"]) {
    const skin = facePart(models.find((model) => model.kind === kind)).skin;
    for (const face of ["right", "left"]) {
      const image = paintAquaticSkinFace(skin, face);
      const row = Math.floor(image.height * 0.375);
      const eyes = [];
      for (let x = 0; x < image.width; x++)
        if (luminance(pixel(image, x, row)) < 75)
          eyes.push((x + 0.5) / image.width);
      assert.ok(eyes.length > 0, `${kind}/${face}: side eye was lost`);
      const forward =
        eyes.reduce((sum, u) => sum + (face === "right" ? 1 - u : u), 0) /
        eyes.length;
      assert.ok(forward > 0.5, `${kind}/${face}: eye points toward +Z`);
    }
  }
});

test("guardian eyes retain a dark central pupil inside the emissive iris at physical and source sizes", () => {
  for (const kind of ["guardian", "elder_guardian"]) {
    const skin = facePart(models.find((model) => model.kind === kind)).skin;
    for (const descriptor of [
      skin,
      createAquaticSkin(kind, "eye", [1, 1, 1]),
    ]) {
      const image = paintAquaticSkinFace(descriptor, "front");
      const center = pixel(
        image,
        Math.floor(image.width / 2),
        Math.floor(image.height / 2)
      );
      assert.equal(center[3], 0, "the pupil must not become a glowing square");
      assert.ok(luminance(center) < 85);
      const count = emissionCount(image);
      assert.ok(count > 0 && count < image.width * image.height);
      assert.equal(emissionCount(paintAquaticSkinFace(descriptor, "back")), 0);
    }
  }
});

test("alpha is emission only; opaque aquatic bodies and animals never consume gel instances", () => {
  let eyeFaces = 0;
  for (const skin of skins) {
    for (const face of MOB_SKIN_FACES) {
      const image = paintAquaticSkinFace(skin, face);
      const count = emissionCount(image);
      const eye =
        face === "front" &&
        ((skin.kind === "drowned" && skin.role === "head") ||
          (["guardian", "elder_guardian"].includes(skin.kind) &&
            skin.role === "eye"));
      if (eye) {
        assert.ok(count > 0 && count < image.width * image.height, skin.key);
        eyeFaces++;
      } else {
        assert.equal(count, 0, `${skin.key}/${face}: not surface transparency`);
      }
      assert.equal(skin.translucent, false);
    }
  }
  assert.ok(eyeFaces > 0);
});

test("drowned clothes, exposed skin, and turtle scutes have different original pixel treatments", () => {
  const shirt = paintAquaticSkinFace(
    createAquaticSkin("drowned", "shirt", [1, 1, 1]),
    "front"
  );
  const arm = paintAquaticSkinFace(
    createAquaticSkin("drowned", "arm", [1, 1, 1]),
    "front"
  );
  const pants = paintAquaticSkinFace(
    createAquaticSkin("drowned", "pants", [1, 1, 1]),
    "front"
  );
  assert.notEqual(digest(shirt), digest(arm));
  assert.notEqual(digest(shirt), digest(pants));
  const shell = paintAquaticSkinFace(
    createAquaticSkin("turtle", "shell", [1, 1, 1]),
    "top"
  );
  const belly = paintAquaticSkinFace(
    createAquaticSkin("turtle", "belly", [1, 1, 1]),
    "top"
  );
  assert.notEqual(digest(shell), digest(belly));
  assert.notEqual(
    luminance(pixel(shell, 0, 2)),
    luminance(pixel(shell, 3, 2)),
    "scute seams remain structural marks rather than uniform tint"
  );
});

test("six faces and gutters fit the existing tile layout with finite, non-overlapping UV rectangles", () => {
  for (const skin of skins) {
    const [tileWidth, tileHeight] = mobSkinTileSize(skin);
    const padded = [];
    for (const [index, face] of MOB_SKIN_FACES.entries()) {
      const rect = mobSkinFaceRect(skin, face);
      assert.deepEqual([rect.width, rect.height], mobSkinFaceSize(skin, index));
      assert.ok(rect.x >= 1 && rect.y >= 1);
      assert.ok(rect.x + rect.width + 1 <= tileWidth);
      assert.ok(rect.y + rect.height + 1 <= tileHeight);
      padded.push({
        x: rect.x - 1,
        y: rect.y - 1,
        width: rect.width + 2,
        height: rect.height + 2,
      });
      for (const u of [0.0001, 0.5, 0.9999])
        for (const v of [0.0001, 0.5, 0.9999]) {
          const uv = [
            (rect.x + u * rect.width) / tileWidth,
            (rect.y + v * rect.height) / tileHeight,
          ];
          assert.ok(
            uv.every(
              (value) => Number.isFinite(value) && value > 0 && value < 1
            )
          );
        }
    }
    for (let i = 0; i < padded.length; i++)
      for (let j = i + 1; j < padded.length; j++) {
        const a = padded[i],
          b = padded[j];
        assert.ok(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
          `${skin.key}: adjacent face gutters overlap`
        );
      }
  }
});

test("new descriptors fit beside the current CPU catalog under the fixed atlas budgets", () => {
  // Packing arithmetic only: actual painter dispatch/WebGL is an integration test.
  const existing = [...getMobSkinAtlasData().entries.values()].map(
    (entry) => entry.skin
  );
  const unique = new Map(
    [...existing, ...skins].map((skin) => [skin.key, skin])
  );
  assert.ok(unique.size <= MAX_MOB_SKINS);
  const tiles = [...unique.values()]
    .map((skin) => {
      const [width, height] = mobSkinTileSize(skin);
      return { key: skin.key, width, height };
    })
    .sort(
      (a, b) =>
        b.height - a.height ||
        b.width - a.width ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    );
  let x = 0,
    y = 0,
    rowHeight = 0;
  for (const tile of tiles) {
    if (x + tile.width > MOB_SKIN_ATLAS_SIZE) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    assert.ok(tile.width <= MOB_SKIN_ATLAS_SIZE);
    assert.ok(y + tile.height <= MOB_SKIN_ATLAS_SIZE, tile.key);
    x += tile.width;
    rowHeight = Math.max(rowHeight, tile.height);
  }
  const again = AQUATIC_KINDS.flatMap((kind) =>
    createAquaticModel(kind).parts.map((part) => part.skin.key)
  );
  assert.deepEqual(new Set(again), new Set(skins.map((skin) => skin.key)));
});

test("skin factories and painters reject invalid identities, faces and unbounded dimensions", () => {
  for (const kind of ["cod", "__proto__", "constructor", "", null])
    assert.throws(
      () => createAquaticSkin(kind, "head", [1, 1, 1]),
      /Unknown aquatic skin/
    );
  assert.throws(
    () => createAquaticSkin("turtle", "not-a-role", [1, 1, 1]),
    /Unknown aquatic skin role/
  );
  for (const size of [
    [1, 0, 1],
    [-1, 1, 1],
    [1, NaN, 1],
    [1, Infinity, 1],
    [1, 1],
    null,
  ])
    assert.throws(
      () => createAquaticSkin("dolphin", "head", size),
      /finite and positive/
    );
  assert.throws(
    () => createAquaticSkin("dolphin", "head", [5, 1, 1]),
    /bounded face size/
  );
  const skin = createAquaticSkin("guardian", "eye", [1, 1, 1]);
  for (const face of ["invalid", -1, 6, 0.5, NaN])
    assert.throws(() => paintAquaticSkinFace(skin, face), /Unknown skin face/);
  for (const pixels of [
    [1, 1, 65],
    [1, 0, 1],
    [1, 1.5, 1],
    [NaN, 1, 1],
    [1, 1],
    null,
  ])
    assert.throws(
      () => paintAquaticSkinFace({ ...skin, pixels }, "front"),
      /bounded face size/
    );
});
