import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as THREE from "three";
import { AQUATIC_KINDS } from "../src/aquatic-skins.js";
import { BLOCK } from "../src/blocks.js";
import {
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
  MAX_GEL_INSTANCES,
  MAX_MOB_SKINS,
  MOB_GEL_OPACITY,
  MOB_SKIN_ATLAS_SIZE,
  mobSkinFaceRect,
  paintMobAtlasFace,
  patchMobSkinShader,
} from "../src/mob-skin-atlas.js";
import {
  createMobSkin,
  MOB_SKIN_FACES,
  MOB_TEXELS_PER_BLOCK,
  mobSkinFaceSize,
  paintMobSkinFace,
} from "../src/mob-skins.js";
import { MAX_MOBS, MAX_PROJECTILES, MOB_SPECIES } from "../src/mob-species.js";
import { CHUNK_SIZE } from "../src/terrain.js";
import { ecosystem } from "./mob-fixtures.js";

const models = Object.keys(MOB_SPECIES)
  .filter((kind) => !AQUATIC_KINDS.includes(kind))
  .map(createMobModel);
const projectiles = ["arrow", "fireball"].map(createProjectileModel);
const skins = [...models, ...projectiles].flatMap((model) =>
  model.parts.map((part) => part.skin)
);
const atlasSkins = [
  ...skins,
  ...AQUATIC_KINDS.flatMap((kind) =>
    createMobModel(kind).parts.map((part) => part.skin)
  ),
];
const digest = (data) => createHash("sha256").update(data).digest("hex");
const pixel = (image, x, y) => [
  ...image.data.subarray(
    (y * image.width + x) * 4,
    (y * image.width + x) * 4 + 4
  ),
];
const headPart = (model) =>
  model.parts.find((part) =>
    ["head", "skull", "gel", "shell", "mantle"].includes(part.role)
  );

test("legacy species retain deterministic original face skins at physical texel density", () => {
  const faces = new Set();
  for (const model of models) {
    assert.ok(
      model.parts.length > 5 && model.parts.length <= MAX_PARTS_PER_MOB,
      model.kind
    );
    for (const part of model.parts) {
      assert.equal(part.skin.kind, model.kind);
      assert.equal(part.role, part.node.name);
      assert.deepEqual(
        part.skin.pixels,
        part.node.scale
          .toArray()
          .map((size) => Math.max(1, Math.round(size * MOB_TEXELS_PER_BLOCK)))
      );
      assert.ok(part.skin.pixels.every((size) => size > 0 && size <= 64));
    }
    const head = headPart(model).skin;
    const front = paintMobSkinFace(head, "front");
    assert.deepEqual(
      front.data,
      paintMobSkinFace(head, "front").data,
      model.kind
    );
    assert.notEqual(
      digest(front.data),
      digest(paintMobSkinFace(head, "back").data),
      model.kind
    );
    faces.add(digest(front.data));
    for (const [index, face] of MOB_SKIN_FACES.entries()) {
      const painted = paintMobSkinFace(head, face);
      assert.deepEqual(
        [painted.width, painted.height],
        mobSkinFaceSize(head, index)
      );
      assert.equal(painted.data.length, painted.width * painted.height * 4);
    }
  }
  assert.equal(faces.size, models.length, "not a shared generic face");
  for (const model of projectiles) {
    assert.equal(
      model.parts.length,
      3,
      "projectiles retain the three-part budget"
    );
    assert.ok(model.parts.every((part) => part.skin.kind === model.kind));
  }
  assert.throws(
    () => createMobSkin("toString", "head", [1, 1, 1]),
    /Unknown mob skin/
  );
  assert.throws(() => createMobSkin("cow", "body", [1, NaN, 1]), /finite/);
  assert.throws(() => createMobSkin("cow", "body", [1, 1]), /finite/);
  assert.throws(() => createMobSkin("cow", "body", [5, 1, 1]), /bounded face/);
});

test("small physical head textures preserve both inset eyes without eye cuboids", () => {
  for (const kind of ["sheep", "pig", "chicken"]) {
    const model = createMobModel(kind);
    const head = headPart(model);
    const image = paintMobSkinFace(head.skin, "front");
    const sides = new Set();
    for (let y = 0; y < image.height * 0.56; y++) {
      for (let x = 0; x < image.width; x++) {
        const [r, g, b] = pixel(image, x, y);
        if (r * 0.2126 + g * 0.7152 + b * 0.0722 < 115)
          sides.add(x < image.width / 2 ? "left" : "right");
      }
    }
    assert.equal(sides.size, 2, `${kind}: downsampling must not erase an eye`);
    assert.ok(
      !model.parts.some((part) => /pupil|eyeball|eye_white/.test(part.role))
    );
  }
});

test("the creeper's physical face keeps separate square eyes and a readable frown", () => {
  const head = headPart(createMobModel("creeper"));
  const image = paintMobSkinFace(head.skin, "front");
  assert.deepEqual([image.width, image.height], [10, 9]);
  const inkAt = (x, y) => {
    const [r, g, b] = pixel(image, x, y);
    return r * 0.2126 + g * 0.7152 + b * 0.0722 < 70;
  };
  const inkRow = (y) =>
    Array.from({ length: image.width }, (_, x) => x).filter((x) => inkAt(x, y));
  assert.deepEqual(inkRow(1), [1, 2, 7, 8]);
  assert.deepEqual(inkRow(2), [1, 2, 7, 8]);
  assert.deepEqual(
    inkRow(3),
    [],
    "mottling must not merge the face into a dark mask"
  );
  assert.deepEqual(inkRow(4), [4, 5]);
  assert.deepEqual(inkRow(6), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(inkRow(8), [2, 7], "the lower mouth opens into a frown");
});

test("only intended eye and fire pixels emit; normal animals and gel stay light-dependent", () => {
  let maskedEyes = 0;
  for (const model of [...models, ...projectiles]) {
    for (const part of model.parts) {
      for (let face = 0; face < 6; face++) {
        const image = paintMobSkinFace(part.skin, face);
        let count = 0;
        for (let i = 3; i < image.data.length; i += 4)
          if (image.data[i] > 0) count++;
        const fire = part.role === "flame" || model.kind === "fireball";
        const eyes =
          ["enderman", "spider"].includes(model.kind) &&
          part.role === "head" &&
          face === 4;
        if (!fire && !eyes) assert.equal(count, 0, `${part.skin.key}/${face}`);
        if (eyes) {
          assert.ok(count > 0 && count < image.width * image.height * 0.5);
          maskedEyes++;
        }
        if (fire) {
          assert.ok(count > 0);
          const [r, g, b] = pixel(image, 0, 0);
          assert.ok(
            r > g && g > b,
            "burning undead have orange fire, not emissive bone/skin"
          );
        }
        if (part.skin.tintable)
          for (let i = 0; i < image.data.length; i += 4)
            assert.deepEqual(
              [...image.data.subarray(i, i + 4)],
              [255, 255, 255, 0]
            );
      }
    }
  }
  assert.equal(maskedEyes, 2);
});

test("one bounded atlas packs six oriented faces with copied gutters and stable ordering", () => {
  const atlas = getMobSkinAtlasData();
  assert.equal(atlas.data.byteLength, MOB_SKIN_ATLAS_SIZE ** 2 * 4);
  assert.equal(
    atlas.entries.size,
    new Set(atlasSkins.map((skin) => skin.key)).size
  );
  assert.ok(
    atlas.entries.size <= MAX_MOB_SKINS && atlas.usedHeight <= atlas.size
  );
  assert.deepEqual(
    buildMobSkinAtlasData([...atlasSkins].reverse()).data,
    atlas.data
  );
  for (const entry of atlas.entries.values()) {
    assert.ok(entry.x >= 0 && entry.y >= 0);
    assert.ok(
      entry.x + entry.width <= atlas.size &&
        entry.y + entry.height <= atlas.size
    );
    for (let face = 0; face < 6; face++) {
      const rect = mobSkinFaceRect(entry.skin, face);
      const source = paintMobAtlasFace(entry.skin, face);
      for (const dx of [
        -1,
        0,
        Math.floor(rect.width / 2),
        rect.width - 1,
        rect.width,
      ]) {
        for (const dy of [
          -1,
          0,
          Math.floor(rect.height / 2),
          rect.height - 1,
          rect.height,
        ]) {
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
  assert.throws(
    () =>
      buildMobSkinAtlasData(
        Array.from({ length: MAX_MOB_SKINS + 1 }, (_, i) => ({
          ...skins[0],
          key: `overflow-${i}`,
        }))
      ),
    /fixed atlas budget/
  );
});

test("Lambert shader maps per-instance cuboid faces and keeps emission separate from alpha", () => {
  const resources = createMobSkinResources(3);
  try {
    assert.equal(resources.material.isMeshLambertMaterial, true);
    assert.equal(resources.material.transparent, false);
    assert.equal(resources.material.emissive.getHex(), 0);
    assert.equal(resources.material.map, resources.texture);
    assert.equal(resources.texture.colorSpace, THREE.SRGBColorSpace);
    assert.equal(resources.texture.minFilter, THREE.NearestFilter);
    assert.equal(resources.texture.magFilter, THREE.NearestFilter);
    assert.equal(resources.texture.generateMipmaps, false);
    assert.equal(resources.texture.flipY, false);
    assert.equal(resources.geometry.groups.length, 0);
    const face = resources.geometry.getAttribute("mobFace");
    const normal = resources.geometry.getAttribute("normal");
    const normals = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (let i = 0; i < face.count; i++)
      assert.deepEqual(
        [normal.getX(i), normal.getY(i), normal.getZ(i)],
        normals[face.getX(i)]
      );
    const skin = headPart(createMobModel("creeper")).skin;
    resources.write(0, skin, 0.8);
    resources.update();
    assert.deepEqual(
      [...resources.rects.array.subarray(0, 4)],
      resources.atlas.entries.get(skin.key).rect
    );
    assert.deepEqual([...resources.sizes.array.subarray(0, 3)], skin.pixels);
    assert.ok(Math.abs(resources.flashes.getX(0) - 0.8) < 1e-6);
    assert.throws(() => resources.write(3, skin), /instance budget/);
    assert.throws(
      () => resources.write(1, { ...skin, key: "not-in-catalog" }),
      /Unregistered/
    );
    const shader = {
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    };
    patchMobSkinShader(shader);
    assert.match(shader.vertexShader, /vMapUv = mobSkinRect\.xy/);
    assert.match(shader.vertexShader, /mobSkinSize\.zy/);
    assert.match(
      shader.fragmentShader,
      /diffuseColor\.rgb \*= mobSkinTexel\.rgb/
    );
    assert.match(
      shader.fragmentShader,
      /totalEmissiveRadiance \+= .*mobSkinTexel\.a/
    );
    assert.doesNotMatch(
      shader.fragmentShader,
      /diffuseColor\s*\*=\s*mobSkinTexel/
    );
    assert.match(shader.fragmentShader, /#include <lights_lambert_fragment>/);
  } finally {
    resources.dispose();
  }
});

test("full populations and projectiles share fixed buffers; reload/spawn cannot grow the skin cache", () => {
  const wildlife = ecosystem();
  const atlas = getMobSkinAtlasData();
  const keys = [...atlas.entries.keys()];
  try {
    for (let i = 0; i < MAX_MOBS; i++) {
      const mob = wildlife.spawn("stray", { x: i, y: 9, z: 0 });
      mob.burning = true;
    }
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const model = createProjectileModel("arrow");
      wildlife.projectiles.push({ model, position: model.root.position });
    }
    wildlife.render(0);
    const capacity = MAX_MOBS * MAX_PARTS_PER_MOB + MAX_PROJECTILES * 3;
    assert.equal(wildlife.mesh.instanceMatrix.count, capacity);
    for (const attribute of [
      wildlife.skinResources.rects,
      wildlife.skinResources.sizes,
      wildlife.skinResources.flashes,
    ])
      assert.equal(attribute.count, capacity);
    assert.equal(
      wildlife.mesh.count,
      MAX_MOBS * wildlife.entities[0].model.parts.length + MAX_PROJECTILES * 3
    );
    assert.ok(wildlife.mesh.count <= capacity);
    assert.equal(wildlife.group.children.length, 1);
    assert.equal(wildlife.mesh.material, wildlife.material);
    const save = wildlife.serialize();
    for (let i = 0; i < 3; i++) assert.equal(wildlife.load(save), true);
    assert.equal(getMobSkinAtlasData(), atlas);
    assert.deepEqual([...atlas.entries.keys()], keys);
  } finally {
    wildlife.dispose();
  }
});

test("conditional parts, damage and fuse flashes upload the right UVs without changing saved state", () => {
  const wildlife = ecosystem();
  try {
    const wolf = wildlife.spawn("wolf", { x: 0, y: 9, z: 0 });
    const skeleton = wildlife.spawn("skeleton", { x: 3, y: 9, z: 0 });
    const creeper = wildlife.spawn("creeper", { x: 6, y: 9, z: 0 });
    const cube = wildlife.spawn("sulfur_cube", { x: 9, y: 9, z: 0 });
    wolf.tamed = true;
    skeleton.burning = true;
    skeleton.hitFlash = 0.24;
    creeper.fusing = true;
    creeper.fuse = 0.05;
    assert.equal(wildlife.interact(cube, BLOCK.STONE), true);
    const before = wildlife.serialize();
    wildlife.render(0);
    let index = 0;
    const color = new THREE.Color();
    for (const mob of wildlife.entities) {
      for (const part of mob.model.parts) {
        if (part.condition && !mob[part.condition]) continue;
        const rect = wildlife.skinResources.atlas.entries.get(
          part.skin.key
        ).rect;
        assert.deepEqual(
          [
            ...wildlife.skinResources.rects.array.subarray(
              index * 4,
              index * 4 + 4
            ),
          ],
          rect
        );
        const flash = wildlife.skinResources.flashes.getX(index);
        assert.ok(
          Math.abs(
            flash - (mob === skeleton ? 0.7 : mob === creeper ? 0.8 : 0)
          ) < 1e-6
        );
        wildlife.mesh.getColorAt(index, color);
        if (part.skin.tintable)
          assert.ok(
            ["r", "g", "b"].every(
              (key) => Math.abs(color[key] - part.color[key]) < 1e-6
            )
          );
        index++;
      }
    }
    assert.equal(wildlife.mesh.count, index);
    assert.deepEqual(wildlife.serialize(), before);
    const count = index;
    wolf.tamed = skeleton.burning = creeper.fusing = false;
    skeleton.hitFlash = 0;
    wildlife.render(0);
    assert.equal(wildlife.mesh.count, count - 5);
    for (let i = 0; i < wildlife.mesh.count; i++)
      assert.equal(
        wildlife.skinResources.flashes.getX(i),
        0,
        "no stale flash after a conditional instance shifts"
      );
  } finally {
    wildlife.dispose();
  }
});

test("GPU texture, material, geometry, and instance ownership dispose exactly once", () => {
  const first = ecosystem();
  const second = ecosystem();
  const a = first.skinResources,
    b = second.skinResources;
  assert.equal(a.atlas, b.atlas, "only one bounded CPU catalog");
  assert.equal(a.texture.image.data, b.texture.image.data);
  assert.notEqual(a.texture, b.texture, "each world owns its GPU lifetime");
  const disposed = new Map();
  for (const resource of [first.mesh, a.geometry, a.material, a.texture]) {
    disposed.set(resource, 0);
    resource.addEventListener("dispose", () =>
      disposed.set(resource, disposed.get(resource) + 1)
    );
  }
  first.dispose();
  first.dispose();
  a.dispose();
  assert.deepEqual([...disposed.values()], [1, 1, 1, 1]);
  second.spawn("sheep", { x: 0, y: 9, z: 0 });
  second.render(0);
  assert.ok(
    second.mesh.count > 0,
    "disposing one world does not invalidate another's texture"
  );
  second.dispose();
});

test("the bounded gel batch borrows the opaque atlas without changing alpha or light semantics", () => {
  const opaque = createMobSkinResources(1);
  const gel = createMobGelResources(opaque);
  let textureDisposals = 0;
  opaque.texture.addEventListener("dispose", () => textureDisposals++);
  try {
    assert.equal(gel.texture, opaque.texture);
    assert.equal(gel.atlas, opaque.atlas);
    assert.notEqual(gel.geometry, opaque.geometry);
    assert.notEqual(gel.material, opaque.material);
    assert.equal(gel.material.map, opaque.texture);
    assert.equal(gel.material.isMeshLambertMaterial, true);
    assert.equal(gel.material.transparent, true);
    assert.equal(gel.material.opacity, MOB_GEL_OPACITY);
    assert.ok(MOB_GEL_OPACITY > 0 && MOB_GEL_OPACITY < 1);
    assert.equal(gel.material.depthWrite, false);
    assert.equal(gel.material.depthTest, true);
    assert.equal(gel.material.blending, THREE.NormalBlending);
    assert.equal(gel.material.side, THREE.FrontSide);
    assert.equal(gel.material.emissive.getHex(), 0);
    assert.equal(gel.geometry.groups.length, 0);
    for (const attribute of [gel.rects, gel.sizes, gel.flashes])
      assert.equal(attribute.count, MAX_MOBS * MAX_GEL_PARTS_PER_MOB);
    const shell = createMobModel("slime").parts[0].skin;
    gel.write(MAX_GEL_INSTANCES - 1, shell, 0.7);
    assert.throws(() => gel.write(MAX_GEL_INSTANCES, shell), /instance budget/);
    assert.equal(opaque.material.transparent, false);
    assert.equal(opaque.material.opacity, 1);
    assert.equal(opaque.material.depthWrite, true);
    gel.dispose();
    gel.dispose();
    assert.equal(
      textureDisposals,
      0,
      "the borrowed atlas remains owned by the opaque batch"
    );
  } finally {
    gel.dispose();
    opaque.dispose();
  }
  assert.equal(textureDisposals, 1);
});

test("a full slime population uses one bounded gel batch with reusable records and buffers", () => {
  const wildlife = ecosystem();
  try {
    for (let i = 0; i < MAX_MOBS; i++)
      assert.ok(wildlife.spawn("slime", { x: i, y: 9, z: 0 }));
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const model = createProjectileModel("arrow");
      wildlife.projectiles.push({ model, position: model.root.position });
    }
    wildlife.render(0);
    const mesh = wildlife.gelMesh;
    const resources = wildlife.gelResources;
    const records = wildlife.gelInstances;
    const recordSet = new Set(records);
    const buffers = [
      mesh.instanceMatrix.array,
      mesh.instanceColor.array,
      resources.rects.array,
      resources.sizes.array,
      resources.flashes.array,
    ];
    assert.equal(mesh.count, MAX_GEL_INSTANCES);
    assert.equal(mesh.instanceMatrix.count, MAX_GEL_INSTANCES);
    assert.equal(wildlife.mesh.count, MAX_MOBS + MAX_PROJECTILES * 3);
    assert.equal(wildlife.group.children.length, 2);
    assert.equal(resources.texture, wildlife.skinResources.texture);
    assert.equal(
      mesh.castShadow,
      false,
      "a clear shell must not cast an opaque shadow"
    );
    const before = wildlife.serialize();
    for (let frame = 0; frame < 20; frame++) {
      wildlife.render(0.05);
      assert.equal(wildlife.gelMesh, mesh);
      assert.equal(wildlife.gelResources, resources);
      assert.equal(wildlife.gelInstances, records);
      assert.ok(records.every((record) => recordSet.has(record)));
      const current = [
        mesh.instanceMatrix.array,
        mesh.instanceColor.array,
        resources.rects.array,
        resources.sizes.array,
        resources.flashes.array,
      ];
      for (let i = 0; i < buffers.length; i++)
        assert.equal(current[i], buffers[i]);
    }
    assert.deepEqual(wildlife.serialize(), before);
    assert.equal(getMobSkinAtlasData(), resources.atlas);
  } finally {
    wildlife.dispose();
  }
});

test("gel instances sort back to front with matching UVs and damage tint as the view reverses", () => {
  const wildlife = ecosystem();
  try {
    const mobs = [4, 0, 8].map((z) =>
      wildlife.spawn("slime", { x: 0, y: 9, z })
    );
    mobs[0].hitFlash = 0.2;
    wildlife.hasPlayer = true;
    for (const [z, forward] of [
      [14, -1],
      [-4, 1],
    ]) {
      wildlife.player.set(0, 9, z);
      Object.assign(wildlife.context.playerEye, { x: 0, y: 10, z });
      wildlife.context.playerForward = { x: 0, y: 0, z: forward };
      wildlife.render(0);
      const expected = mobs
        .flatMap((mob) =>
          mob.model.parts.filter((part) => part.skin.translucent)
        )
        .sort(
          (a, b) =>
            (b.node.matrixWorld.elements[14] -
              a.node.matrixWorld.elements[14]) *
            forward
        );
      const color = new THREE.Color();
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < wildlife.gelCount; i++) {
        const record = wildlife.gelInstances[i];
        assert.equal(record.part, expected[i]);
        if (i) assert.ok(wildlife.gelInstances[i - 1].depth >= record.depth);
        const entry = wildlife.gelResources.atlas.entries.get(
          record.part.skin.key
        );
        assert.deepEqual(
          [...wildlife.gelResources.rects.array.subarray(i * 4, i * 4 + 4)],
          entry.rect
        );
        wildlife.gelMesh.getMatrixAt(i, matrix);
        assert.ok(
          Math.abs(
            matrix.elements[14] +
              wildlife.gelMesh.position.z -
              record.part.node.matrixWorld.elements[14]
          ) < 1e-5
        );
        const hit = mobs[0].model.parts.includes(record.part);
        assert.ok(
          Math.abs(wildlife.gelResources.flashes.getX(i) - (hit ? 0.7 : 0)) <
            1e-6
        );
        wildlife.gelMesh.getColorAt(i, color);
        const expectedColor = new THREE.Color(hit ? "#ff7c70" : "#ffffff");
        for (const channel of ["r", "g", "b"])
          assert.ok(Math.abs(color[channel] - expectedColor[channel]) < 1e-6);
      }
    }
    mobs[0].hitFlash = 0;
    mobs[1].dormant = true;
    wildlife.render(0);
    assert.equal(wildlife.gelCount, MAX_GEL_PARTS_PER_MOB * 2);
    for (let i = 0; i < wildlife.gelCount; i++) {
      assert.equal(wildlife.gelResources.flashes.getX(i), 0);
      assert.ok(!mobs[1].model.parts.includes(wildlife.gelInstances[i].part));
    }
  } finally {
    wildlife.dispose();
  }
});

test("gel batches release at invisibility, leave sulfur opaque, and dispose the shared atlas only once", () => {
  const wildlife = ecosystem();
  const disposed = new Map();
  const watch = (resource) => {
    disposed.set(resource, 0);
    resource.addEventListener("dispose", () =>
      disposed.set(resource, disposed.get(resource) + 1)
    );
  };
  try {
    const cube = wildlife.spawn("sulfur_cube", { x: 3, y: 9, z: 0 });
    wildlife.interact(cube, BLOCK.STONE);
    wildlife.render(0);
    assert.equal(wildlife.gelMesh, null);
    const cubeCount = wildlife.mesh.count;
    const atlas = wildlife.skinResources.texture;
    watch(atlas);
    const slime = wildlife.spawn("slime", { x: 0, y: 9, z: 0 });
    for (let cycle = 0; cycle < 3; cycle++) {
      slime.dormant = false;
      wildlife.render(0);
      const resources = wildlife.gelResources;
      const owned = [wildlife.gelMesh, resources.geometry, resources.material];
      owned.forEach(watch);
      assert.equal(wildlife.mesh.count, cubeCount + 1);
      assert.equal(resources.texture, atlas);
      assert.equal(wildlife.material.transparent, false);
      assert.ok(cube.model.parts.every((part) => !part.skin.translucent));
      slime.dormant = true;
      wildlife.render(0);
      wildlife.render(0);
      assert.equal(wildlife.gelMesh, null);
      assert.equal(wildlife.gelResources, null);
      assert.equal(wildlife.group.children.length, 1);
      assert.equal(wildlife.mesh.count, cubeCount);
      assert.ok(wildlife.gelInstances.every((record) => record.part === null));
      assert.ok(owned.every((resource) => disposed.get(resource) === 1));
      assert.equal(disposed.get(atlas), 0);
    }
    slime.dormant = false;
    wildlife.render(0);
    [
      wildlife.gelMesh,
      wildlife.gelResources.geometry,
      wildlife.gelResources.material,
    ].forEach(watch);
    const remainingGel = wildlife.gelResources;
    wildlife.dispose();
    wildlife.dispose();
    remainingGel.dispose();
    assert.ok([...disposed.values()].every((count) => count === 1));
  } finally {
    wildlife.dispose();
  }
});

test("both slime layers keep exact picking and world-local uploads through far-coordinate rebases", () => {
  for (const offset of [0, 29_000_000, -29_000_000]) {
    const wildlife = ecosystem();
    try {
      const slime = wildlife.spawn("slime", {
        x: offset + 0.375,
        y: 9,
        z: -offset + 0.625,
      });
      slime.root.rotation.y = 0.31;
      wildlife.render(0);
      const before = wildlife.serialize();
      const matrices = slime.model.parts.map((part) =>
        part.node.matrixWorld.elements.slice()
      );
      const shell = slime.model.parts[0].node;
      const origin = new THREE.Vector3(0.49, 0, 1.5).applyMatrix4(
        shell.matrixWorld
      );
      const surface = new THREE.Vector3(0.49, 0, 0.5).applyMatrix4(
        shell.matrixWorld
      );
      const direction = new THREE.Vector3(0, 0, -1).transformDirection(
        shell.matrixWorld
      );
      const miss = new THREE.Vector3(0.6, 0, 1.5).applyMatrix4(
        shell.matrixWorld
      );
      const initial = wildlife.raycast(origin, direction, 5);
      assert.equal(
        initial?.entity,
        slime,
        "pick the gel edge, not just the inner core"
      );
      assert.ok(Math.abs(initial.distance - origin.distanceTo(surface)) < 1e-5);
      assert.equal(
        wildlife.raycast(miss, direction, 5),
        null,
        "not the broad-phase box"
      );
      for (const shift of [15.9, 16.1, 32.1, -0.1, 0.1, 16.1]) {
        const player = new THREE.Vector3(offset + shift, 9, -offset - shift);
        wildlife.update(0, 0, player);
        assert.equal(
          wildlife.gelMesh.position.x,
          Math.floor(player.x / CHUNK_SIZE) * CHUNK_SIZE
        );
        assert.deepEqual(wildlife.gelMesh.position, wildlife.mesh.position);
        wildlife.scene.updateMatrixWorld(true);
        for (const [mesh, parts] of [
          [
            wildlife.mesh,
            slime.model.parts.filter((part) => !part.skin.translucent),
          ],
          [
            wildlife.gelMesh,
            wildlife.gelInstances
              .slice(0, wildlife.gelCount)
              .map((record) => record.part),
          ],
        ]) {
          assert.equal(mesh.count, parts.length);
          for (let i = 0; i < parts.length; i++) {
            const upload = new THREE.Matrix4();
            mesh.getMatrixAt(i, upload);
            for (const axis of [12, 13, 14])
              assert.ok(Math.abs(upload.elements[axis]) < 128);
            upload.premultiply(mesh.matrixWorld);
            for (let element = 0; element < 16; element++)
              assert.ok(
                Math.abs(
                  upload.elements[element] -
                    parts[i].node.matrixWorld.elements[element]
                ) < 1e-5
              );
          }
        }
        const hit = wildlife.raycast(origin, direction, 5);
        assert.equal(hit?.entity, slime);
        assert.ok(Math.abs(hit.distance - initial.distance) < 1e-5);
        assert.equal(wildlife.raycast(miss, direction, 5), null);
        assert.deepEqual(
          slime.model.parts.map((part) => part.node.matrixWorld.elements),
          matrices
        );
      }
      assert.deepEqual(wildlife.serialize(), before);
    } finally {
      wildlife.dispose();
    }
  }
});
