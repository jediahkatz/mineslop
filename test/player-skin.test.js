import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as THREE from "three";
import {
  getMobSkinAtlasData,
  mobSkinFaceRect,
  patchMobSkinShader,
} from "../src/mob-skin-atlas.js";
import { MOB_SKIN_FACES, mobSkinFaceSize } from "../src/mob-skins.js";
import {
  createPlayerSkinResources,
  getPlayerSkinAtlasData,
  MAX_PLAYER_PARTS,
  PLAYER_SKIN_ATLAS_SIZE,
  PLAYER_SKINS,
  paintPlayerSkinFace,
} from "../src/player-skin.js";

const digest = (data) => createHash("sha256").update(data).digest("hex");
const pixel = (image, x, y) => [
  ...image.data.subarray(
    (y * image.width + x) * 4,
    (y * image.width + x) * 4 + 4
  ),
];

test("original human skin is deterministic, non-emissive, and has a distinct front", () => {
  for (const skin of Object.values(PLAYER_SKINS)) {
    for (const [index, face] of MOB_SKIN_FACES.entries()) {
      const image = paintPlayerSkinFace(skin, face);
      assert.deepEqual(
        [image.width, image.height],
        mobSkinFaceSize(skin, index)
      );
      assert.deepEqual(image.data, paintPlayerSkinFace(skin, index).data);
      assert.equal(image.data.length, image.width * image.height * 4);
      for (let alpha = 3; alpha < image.data.length; alpha += 4)
        assert.equal(
          image.data[alpha],
          0,
          "appearance alone never emits light"
        );
    }
  }
  const front = paintPlayerSkinFace(PLAYER_SKINS.head, "front");
  const back = paintPlayerSkinFace(PLAYER_SKINS.head, "back");
  assert.notEqual(digest(front.data), digest(back.data));
  const [r, g, b] = pixel(front, 5, 4);
  assert.ok(r > g && g > b, "warm human skin, not green undead skin");
  const leftEye = pixel(front, 1, 3);
  const rightEye = pixel(front, 6, 3);
  assert.ok(
    leftEye[0] < 80 && rightEye[0] < 80,
    "both eyes survive the texel grid"
  );
  assert.throws(() => paintPlayerSkinFace({ role: "head" }, 0), /Unknown/);
  assert.throws(
    () => paintPlayerSkinFace(PLAYER_SKINS.head, "invalid"),
    /Unknown/
  );
});

test("the bounded player atlas packs correctly oriented faces and copied gutters", () => {
  const atlas = getPlayerSkinAtlasData();
  assert.equal(atlas, getPlayerSkinAtlasData());
  assert.equal(atlas.size, PLAYER_SKIN_ATLAS_SIZE);
  assert.equal(atlas.data.byteLength, atlas.size ** 2 * 4);
  assert.equal(atlas.entries.size, Object.keys(PLAYER_SKINS).length);
  assert.ok(atlas.usedHeight <= atlas.size);
  for (const entry of atlas.entries.values()) {
    assert.ok(entry.x >= 0 && entry.x + entry.width <= atlas.size);
    assert.ok(entry.y >= 0 && entry.y + entry.height <= atlas.size);
    for (let face = 0; face < 6; face++) {
      const source = paintPlayerSkinFace(entry.skin, face);
      const rect = mobSkinFaceRect(entry.skin, face);
      for (const dx of [-1, 0, rect.width - 1, rect.width]) {
        for (const dy of [-1, 0, rect.height - 1, rect.height]) {
          const actual = pixel(
            { width: atlas.size, data: atlas.data },
            entry.x + rect.x + dx,
            entry.y + rect.y + dy
          );
          const expected = pixel(
            source,
            Math.max(0, Math.min(source.width - 1, dx)),
            Math.max(0, Math.min(source.height - 1, source.height - 1 - dy))
          );
          assert.deepEqual(
            actual,
            expected,
            `${entry.skin.key}/${face}/${dx},${dy}`
          );
        }
      }
    }
  }
});

test("player resources reuse the lit cuboid shader and own a bounded world-local batch", () => {
  const resources = createPlayerSkinResources();
  try {
    assert.equal(resources.texture.colorSpace, THREE.SRGBColorSpace);
    assert.equal(resources.texture.minFilter, THREE.NearestFilter);
    assert.equal(resources.texture.magFilter, THREE.NearestFilter);
    assert.equal(resources.texture.generateMipmaps, false);
    assert.equal(resources.texture.flipY, false);
    assert.equal(resources.material.isMeshLambertMaterial, true);
    assert.equal(resources.material.transparent, false);
    assert.equal(resources.material.depthWrite, true);
    assert.equal(resources.material.emissive.getHex(), 0);
    assert.equal(resources.material.map, resources.texture);
    assert.equal(resources.material.onBeforeCompile, patchMobSkinShader);
    assert.equal(resources.geometry.groups.length, 0);
    const faces = resources.geometry.getAttribute("mobFace");
    const normal = resources.geometry.getAttribute("normal");
    const normals = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (let i = 0; i < faces.count; i++)
      assert.deepEqual(
        [normal.getX(i), normal.getY(i), normal.getZ(i)],
        normals[faces.getX(i)]
      );
    for (const attribute of [
      resources.rects,
      resources.sizes,
      resources.flashes,
    ])
      assert.equal(attribute.count, MAX_PLAYER_PARTS);
    resources.write(0, PLAYER_SKINS.head);
    resources.write(MAX_PLAYER_PARTS - 1, PLAYER_SKINS.metal);
    resources.update();
    assert.deepEqual(
      [...resources.rects.array.subarray(0, 4)],
      resources.atlas.entries.get(PLAYER_SKINS.head.key).rect
    );
    assert.deepEqual(
      [...resources.sizes.array.subarray(0, 3)],
      PLAYER_SKINS.head.pixels
    );
    assert.throws(
      () => resources.write(MAX_PLAYER_PARTS, PLAYER_SKINS.head),
      /budget/
    );
    assert.throws(() => resources.write(-1, PLAYER_SKINS.head), /budget/);
    assert.throws(() => resources.write(0, { key: "missing" }), /Unregistered/);
  } finally {
    resources.dispose();
  }
});

test("creating and disposing player resources leaves the existing NPC atlas byte-identical", () => {
  const npc = getMobSkinAtlasData();
  const before = digest(npc.data);
  const keys = [...npc.entries.keys()];
  const a = createPlayerSkinResources();
  const b = createPlayerSkinResources();
  assert.notEqual(a.atlas, npc);
  assert.equal(a.atlas, b.atlas);
  assert.equal(a.texture.image.data, b.texture.image.data);
  assert.notEqual(a.texture, b.texture);
  a.dispose();
  a.dispose();
  b.write(0, PLAYER_SKINS.head);
  b.update();
  b.dispose();
  assert.equal(getMobSkinAtlasData(), npc);
  assert.equal(digest(npc.data), before);
  assert.deepEqual([...npc.entries.keys()], keys);
  assert.ok(keys.every((key) => !key.startsWith("player/")));
});
