import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { CaveDaylight } from "../src/cave-daylight.js";
import { DaylightMaterial, sampleDaylightAt } from "../src/daylight-material.js";
import { raycast } from "../src/raycast.js";
import { GameRenderer } from "../src/renderer.js";
import { SkyColumns } from "../src/sky-columns.js";
import { World } from "../src/world.js";
import { dispatch } from "./control-fixture.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { flushColumns } from "./light-renderer-fixture.js";

const sites = [
  { version: 3, position: { x: 1035.5, y: 32, z: 1489.5 },
    roots: [{ x: 1035, y: 32, z: 1487 }, { x: 1033, y: 32, z: 1488 }] },
  { version: 7, position: { x: 3840.5, y: 71, z: -5085.5 },
    roots: [{ x: 3840, y: 71, z: -5088 }, { x: 3841, y: 71, z: -5088 }] },
];

// Real Game controls, mining, native World transactions, observer binding and
// CPU light fields. This fixture has no WebGL submission or pixel oracle.
for (const site of sites) {
  test(`natural v${site.version} paid bamboo edits retain verified daylight at R12`, async (t) => {
    t.mock.method(performance, "now", () => 0);
    const world = new World("cedar-valley", { generatorVersion: site.version, useWorker: false });
    const f = await gameMobFixture(t, {
      world, generatorFactory: null, spawnPosition: site.position, admissionRadius: 3,
    });
    const { game } = f, graphics = game.graphics;
    const columns = new SkyColumns(12);
    const material = new DaylightMaterial(columns, f.scene);
    const cave = new CaveDaylight(columns);
    Object.assign(graphics, {
      world, renderRadius: 12, skyColumns: columns, daylightMaterial: material,
      blockLight: material.blockLight, onWorldMutation: GameRenderer.prototype.onWorldMutation,
    });
    t.after(() => { material.dispose(); columns.dispose(); });
    f.hold("WOOD_AXE");
    assert.equal(world.edits.size, 0, "natural generator inputs, no authored voxel setup");
    for (const root of site.roots) {
      assert.equal(world.get(root.x, root.y, root.z), BLOCK.BAMBOO);
      assert.equal(world.generator.getBiome(root.x, root.z).id, "bamboo_jungle");
    }

    const points = [];
    for (const x of [-0.5, 0, 0.5]) for (const z of [-0.5, 0, 0.5]) {
      const hit = raycast(world, graphics.camera.position, new THREE.Vector3(x, -1, z).normalize(),
        12, { channel: "occlusion" });
      assert.ok(hit, "physical ground receiver");
      points.push(new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z)
        .addScaledVector(new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), 0.02));
    }
    const masks = () => points.map((point) => sampleDaylightAt(columns, point));
    const observations = [];
    graphics.update = () => {
      material.blockLight.update(world, graphics.camera.position, 12);
      columns.begin(world);
      columns.updateField(graphics.camera.position, 12);
      flushColumns(columns);
      graphics.skyAccess = cave.sample(world, graphics.camera.position, f.player.forward);
      assert.ok(columns.stats.cellReads <= 8192);
      assert.ok(columns.stats.surfaceCellReads <= 8192);
      assert.ok(columns.topologyWork.cells <= 8192);
      observations.push({ revision: world._editRevision, masks: masks(),
        directSky: graphics.skyAccess.directSky });
    };
    let warmFrames = 0;
    while (warmFrames++ < 512) {
      graphics.update();
      if (masks().every(({ direct, ambient }) => direct === 1 && ambient === 1)) break;
    }
    assert.ok(warmFrames < 512, "establish verified receivers before editing");
    assert.equal(graphics.skyAccess.directSky, true);
    const beforeMasks = masks();
    const receiverKeys = new Set(points.map((p) => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`));

    for (const root of site.roots) {
      const verified = new Map([...receiverKeys].map((key) => [key, columns.cache.get(key)]));
      const observationStart = observations.length;
      const revision = world._editRevision, hand = game.gameplay.getHandStack();
      const above = world.getCell(root.x, root.y + 1, root.z);
      f.aim({ x: root.x + 0.5, y: root.y, z: root.z + 0.5 }, 0.65);
      f.withGlobals(() => game.updateTarget());
      assert.deepEqual({ x: game.target?.x, y: game.target?.y, z: game.target?.z }, root);
      f.withGlobals(() => dispatch(game.container, "mousedown", { button: 0, target: game.container }));
      try {
        assert.equal(game.heldAction, "mine");
        for (let i = 0; i < 40 && world._editRevision === revision; i++) f.frame();
      } finally {
        f.withGlobals(() => dispatch(f.document, "mouseup", { button: 0, target: game.container }));
      }
      assert.equal(world.get(root.x, root.y, root.z), BLOCK.AIR);
      assert.equal(world._editRevision, revision + 1);
      assert.equal(game.gameplay.getHandStack().durability, hand.durability - 1);
      assert.deepEqual(world.getCell(root.x, root.y + 1, root.z), above,
        "retain the actual harvest's existing stalk/support semantics");
      f.frame(3);
      const after = observations.slice(observationStart).filter((row) => row.revision > revision);
      assert.ok(after.length >= 3, "continue the actual Game loop after the mutation");
      t.diagnostic(JSON.stringify({
        version: site.version, root, revision: world._editRevision,
        durability: [hand.durability, game.gameplay.getHandStack().durability],
        before: beforeMasks, after: after.map((row) => row.masks),
        pendingSky: columns.requests.size,
      }));
      for (const row of after) {
        assert.deepEqual(row.masks, beforeMasks, "bamboo removal cannot change verified daylight");
        assert.equal(row.directSky, true, "the same outdoor camera remains outdoors");
      }
      for (const [key, entry] of verified) {
        assert.equal(columns.cache.get(key), entry, "unchanged ceilings do not reenter the cold queue");
        assert.equal(columns.requests.has(key), false);
      }
    }
  });
}
