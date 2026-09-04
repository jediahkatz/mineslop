import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createAquaticModel } from "../src/aquatic-models.js";
import {
  AQUATIC_KINDS,
  createAquaticSkin,
  paintAquaticSkinFace,
} from "../src/aquatic-skins.js";
import { ECOLOGY_SPECIES } from "../src/expansion-ecology.js";
import {
  animateMob,
  createMobModel,
  createProjectileModel,
  MAX_GEL_PARTS_PER_MOB,
  MAX_PARTS_PER_MOB,
} from "../src/mob-models.js";
import {
  buildMobSkinAtlasData,
  createMobGelResources,
  createMobSkinResources,
  getMobSkinAtlasData,
  MAX_MOB_SKINS,
  MOB_SKIN_ATLAS_SIZE,
  mobSkinFaceRect,
  paintMobAtlasFace,
} from "../src/mob-skin-atlas.js";
import {
  createMobSkin,
  MOB_SKIN_FACES,
  paintMobSkinFace,
} from "../src/mob-skins.js";
import { MAX_MOBS, MAX_PROJECTILES, MOB_SPECIES } from "../src/mob-species.js";
import { NPC_KINDS, paintNpcSkinFace } from "../src/npc-skins.js";
import { catalogSkins, LEGACY_MOB_KINDS } from "./mob-asset-fixtures.js";

function signature(model) {
  model.root.updateMatrixWorld(true);
  return model.parts.map((part) => ({
    name: part.name,
    role: part.role,
    skin: part.skin,
    matrix: part.node.matrixWorld.elements.slice(),
  }));
}

function texel(data, width, x, y) {
  const start = (y * width + x) * 4;
  return data.subarray(start, start + 4);
}

test("shared factory fits authored aquatic visuals to ecology bounds without mutating the registry", () => {
  const registered = Object.entries(MOB_SPECIES);
  for (const kind of LEGACY_MOB_KINDS) {
    assert.ok(Object.hasOwn(MOB_SPECIES, kind), `${kind}: legacy entry retained`);
    assert.notEqual(MOB_SPECIES[kind].ecology, true, kind);
  }
  for (const [kind, spec] of registered) {
    if (LEGACY_MOB_KINDS.includes(kind)) continue;
    assert.equal(spec, ECOLOGY_SPECIES[kind], `${kind}: native ecology entry`);
    assert.equal(spec.ecology, true);
    assert.ok(Number.isFinite(spec.height) && spec.height > 0, kind);
    const family = AQUATIC_KINDS.includes(kind) ? "aquatic" : "npc";
    assert.ok(AQUATIC_KINDS.includes(kind) || NPC_KINDS.includes(kind), kind);
    assert.ok(
      createMobModel(kind).parts.every((part) => part.skin.family === family)
    );
  }
  for (const kind of AQUATIC_KINDS) {
    const model = createMobModel(kind);
    const authored = createAquaticModel(kind);
    const scale = Math.min(
      1, MOB_SPECIES[kind].height / authored.localBounds.max.y
    );
    const actual = signature(model);
    const original = signature(authored);
    assert.equal(actual.length, original.length);
    for (let index = 0; index < actual.length; index++) {
      const { matrix, ...part } = actual[index];
      const { matrix: originalMatrix, ...originalPart } = original[index];
      assert.deepEqual(
        part, originalPart, `${kind}/${index}: authored skin and role`
      );
      const expected = new THREE.Matrix4()
        .makeScale(scale, scale, scale)
        .multiply(new THREE.Matrix4().fromArray(originalMatrix)).elements;
      for (let element = 0; element < 16; element++)
        assert.ok(
          Math.abs(matrix[element] - expected[element]) < 1e-12,
          `${kind}/${index}: only the declared ecology display scale may change`
        );
      assert.deepEqual(
        model.parts[index].node.scale, authored.parts[index].node.scale
      );
    }
    assert.deepEqual(
      model.root.scale.toArray(), [1, 1, 1], "root scale stays available for age"
    );
    assert.ok(model.localBounds.max.y <= MOB_SPECIES[kind].height + 1e-12);
    assert.ok(Math.abs(model.pickHeight - authored.pickHeight * scale) < 1e-12);
    assert.ok(Math.abs(model.pickRadius - authored.pickRadius * scale) < 1e-12);
    assert.equal(model.animation.swim.node, model.visual);
    assert.ok(model.parts.length <= MAX_PARTS_PER_MOB);
    assert.ok(
      model.parts.filter((part) => part.skin.translucent).length <=
        MAX_GEL_PARTS_PER_MOB
    );
    assert.ok(model.parts.every((part) => part.skin.family === "aquatic"));
  }
  assert.deepEqual(Object.entries(MOB_SPECIES), registered);
  assert.throws(() => createMobModel("not-a-mob"), /Unknown mob/);
});

test("legacy factories, skin descriptors, animator path and projectiles remain intact", () => {
  for (const kind of LEGACY_MOB_KINDS) {
    const spec = MOB_SPECIES[kind];
    const model = createMobModel(kind);
    assert.equal(model.animation, undefined);
    for (const part of model.parts)
      assert.deepEqual(
        part.skin,
        createMobSkin(kind, part.role, part.node.scale.toArray()),
        `${kind}/${part.role}`
      );
    const entity = {
      kind,
      model,
      spec,
      position: model.root.position,
      moving: true,
      stride: 0,
      phase: 0.2,
      velocityY: 0,
      groundY: 0,
    };
    if (kind === "horse") {
      // Horse gait samples real grounded movement, not a blocked AI intent.
      animateMob(entity, 0.05, 0);
      assert.equal(entity.stride, 0);
      entity.position.x += 0.1;
    }
    const before = entity.position.toArray();
    animateMob(entity, 0.05, 0.05);
    assert.ok(Number.isFinite(entity.stride) && entity.stride > 0);
    assert.deepEqual(entity.position.toArray(), before);
    for (const part of model.parts)
      assert.ok(part.node.matrixWorld.elements.every(Number.isFinite), kind);
  }
  for (const [kind, roles] of [
    ["arrow", ["shaft", "arrowhead", "feather"]],
    ["fireball", ["fire", "flame", "ember"]],
  ]) {
    const model = createProjectileModel(kind);
    assert.deepEqual(
      model.parts.map((part) => part.role),
      roles
    );
    assert.ok(model.parts.every((part) => part.skin.family !== "aquatic"));
  }
});

test("the shared painter dispatches aquatic and NPC families and preserves legacy pixels", () => {
  const aquatic = createMobModel("guardian").parts.find(
    (part) => part.role === "eye"
  ).skin;
  const legacy = createMobModel("enderman").parts.find(
    (part) => part.role === "head"
  ).skin;
  for (const face of MOB_SKIN_FACES) {
    for (const kind of NPC_KINDS) {
      const npc = createMobModel(kind).parts.find(
        (part) => part.role === "head"
      ).skin;
      assert.deepEqual(
        paintMobAtlasFace(npc, face), paintNpcSkinFace(npc, face)
      );
    }
    assert.deepEqual(
      paintMobAtlasFace(aquatic, face),
      paintAquaticSkinFace(aquatic, face)
    );
    assert.deepEqual(
      paintMobAtlasFace(legacy, face),
      paintMobSkinFace(legacy, face)
    );
    assert.deepEqual(
      paintMobAtlasFace({ ...legacy, family: "other" }, face),
      paintMobSkinFace(legacy, face)
    );
  }
});

test("the actual combined atlas is painted once within the unchanged bounded allocation", (t) => {
  const skins = catalogSkins();
  const atlas = getMobSkinAtlasData();
  const keys = new Set(skins.map((skin) => skin.key));
  assert.equal(atlas.size, MOB_SKIN_ATLAS_SIZE);
  assert.equal(atlas.data.byteLength, MOB_SKIN_ATLAS_SIZE ** 2 * 4);
  assert.deepEqual(new Set(atlas.entries.keys()), keys);
  assert.ok(atlas.entries.size <= MAX_MOB_SKINS);
  assert.ok(atlas.usedHeight <= atlas.size);
  assert.equal(getMobSkinAtlasData(), atlas);
  assert.deepEqual(
    buildMobSkinAtlasData([...skins].reverse()).data,
    atlas.data
  );
  const aquaticKeys = new Set(
    skins.filter((skin) => skin.family === "aquatic").map((skin) => skin.key)
  );
  t.diagnostic(
    `Combined CPU atlas: ${atlas.entries.size} skins ` +
      `(${aquaticKeys.size} aquatic), ${atlas.usedHeight}/${atlas.size} rows, ` +
      `${atlas.data.byteLength} RGBA bytes`
  );
});

test("actual atlas texels, emission channels and every gutter agree with all three original painters", () => {
  const atlas = getMobSkinAtlasData();
  for (const entry of atlas.entries.values()) {
    for (const face of MOB_SKIN_FACES) {
      const source =
        entry.skin.family === "npc"
          ? paintNpcSkinFace(entry.skin, face)
          : entry.skin.family === "aquatic"
            ? paintAquaticSkinFace(entry.skin, face)
            : paintMobSkinFace(entry.skin, face);
      const rect = mobSkinFaceRect(entry.skin, face);
      assert.equal(rect.width, source.width);
      assert.equal(rect.height, source.height);
      const x = entry.x + rect.x,
        y = entry.y + rect.y;
      const label = `${entry.skin.key}/${face}`;
      for (let row = 0; row < source.height; row++) {
        const from = (source.height - 1 - row) * source.width * 4;
        const to = ((y + row) * atlas.size + x) * 4;
        assert.deepEqual(
          atlas.data.subarray(to, to + source.width * 4),
          source.data.subarray(from, from + source.width * 4),
          `${label}: albedo/emission row ${row}`
        );
      }
      for (let dy = -1; dy <= source.height; dy++) {
        const sy = Math.max(
          0,
          Math.min(source.height - 1, source.height - 1 - dy)
        );
        for (const [dx, sx] of [
          [-1, 0],
          [source.width, source.width - 1],
        ])
          assert.deepEqual(
            texel(atlas.data, atlas.size, x + dx, y + dy),
            texel(source.data, source.width, sx, sy),
            `${label}: side gutter ${dx},${dy}`
          );
      }
      for (let dx = -1; dx <= source.width; dx++) {
        const sx = Math.max(0, Math.min(source.width - 1, dx));
        for (const [dy, sy] of [
          [-1, source.height - 1],
          [source.height, 0],
        ])
          assert.deepEqual(
            texel(atlas.data, atlas.size, x + dx, y + dy),
            texel(source.data, source.width, sx, sy),
            `${label}: horizontal gutter ${dx},${dy}`
          );
      }
    }
  }
});

test("oversized catalogs fail with a concrete fixed-atlas error instead of changing density", () => {
  const skin = createAquaticSkin("guardian", "body", [4, 4, 4]);
  const pixels = skin.pixels.slice();
  assert.throws(
    () =>
      buildMobSkinAtlasData(
        Array.from({ length: 7 }, (_, index) => ({
          ...skin,
          key: `oversized-aquatic-${index}`,
        }))
      ),
    /fixed atlas.*needs \d+x\d+ at \d+,\d+/
  );
  assert.deepEqual(skin.pixels, pixels);
  assert.throws(
    () =>
      buildMobSkinAtlasData(
        Array.from({ length: MAX_MOB_SKINS + 1 }, (_, index) => ({
          ...skin,
          key: `too-many-aquatic-${index}`,
        }))
      ),
    /fixed atlas budget/
  );
});

test("aquatic populations use the shared fixed buffers and retain single-owner resource disposal", () => {
  const capacity = MAX_MOBS * MAX_PARTS_PER_MOB + MAX_PROJECTILES * 3;
  const opaque = createMobSkinResources(capacity);
  const gel = createMobGelResources(opaque);
  const otherWorld = createMobSkinResources(1);
  const disposed = new Map();
  for (const resource of [
    opaque.texture,
    opaque.geometry,
    opaque.material,
    gel.geometry,
    gel.material,
    otherWorld.texture,
    otherWorld.geometry,
    otherWorld.material,
  ]) {
    disposed.set(resource, 0);
    resource.addEventListener("dispose", () =>
      disposed.set(resource, disposed.get(resource) + 1)
    );
  }
  try {
    const models = Array.from({ length: MAX_MOBS }, (_, index) =>
      createMobModel(AQUATIC_KINDS[index % AQUATIC_KINDS.length])
    );
    const buffers = [
      opaque.rects.array,
      opaque.sizes.array,
      opaque.flashes.array,
    ];
    const atlas = opaque.atlas;
    const keys = [...atlas.entries.keys()];
    assert.equal(opaque.material.map, opaque.texture);
    assert.equal(opaque.material.transparent, false);
    assert.equal(opaque.texture.colorSpace, THREE.SRGBColorSpace);
    assert.equal(opaque.texture.minFilter, THREE.NearestFilter);
    assert.equal(opaque.texture.magFilter, THREE.NearestFilter);
    assert.equal(gel.texture, opaque.texture);
    assert.equal(gel.atlas, opaque.atlas);
    assert.notEqual(otherWorld.texture, opaque.texture);
    assert.equal(otherWorld.atlas, opaque.atlas);
    for (let frame = 0; frame < 3; frame++) {
      let index = 0;
      for (const model of models) {
        for (const part of model.parts) {
          assert.equal(part.skin.translucent, false);
          opaque.write(index, part.skin, frame === 1 ? 0.5 : 0);
          assert.deepEqual(
            [...opaque.rects.array.subarray(index * 4, index * 4 + 4)],
            atlas.entries.get(part.skin.key).rect
          );
          assert.deepEqual(
            [...opaque.sizes.array.subarray(index * 3, index * 3 + 3)],
            part.skin.pixels
          );
          index++;
        }
      }
      assert.ok(index <= capacity);
      opaque.update();
      assert.equal(opaque.rects.array, buffers[0]);
      assert.equal(opaque.sizes.array, buffers[1]);
      assert.equal(opaque.flashes.array, buffers[2]);
      assert.equal(opaque.atlas, getMobSkinAtlasData());
      assert.deepEqual([...atlas.entries.keys()], keys);
    }
    const skin = models[0].parts[0].skin;
    assert.throws(() => opaque.write(capacity, skin), /instance budget/);
    assert.throws(() => createMobSkinResources(capacity + 1), /capacity/);
    gel.dispose();
    gel.dispose();
    assert.equal(disposed.get(opaque.texture), 0, "gel only borrows the atlas");
    opaque.dispose();
    opaque.dispose();
    assert.equal(disposed.get(opaque.texture), 1);
    otherWorld.write(0, skin);
    otherWorld.dispose();
    otherWorld.dispose();
    assert.ok([...disposed.values()].every((count) => count === 1));
  } finally {
    gel.dispose();
    opaque.dispose();
    otherWorld.dispose();
  }
});
