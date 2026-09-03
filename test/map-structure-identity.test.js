import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_STRUCTURE_ID_LENGTH,
  MAX_STRUCTURE_MEMBER_ID_LENGTH,
  parseStructureIdentity,
} from "../src/canonical-structure-identity.js";
import {
  explorationMarkerFromStructure,
  mapResolutionFromStructure,
  normalizeTreasureMapTarget,
  selectTreasureMapTarget,
} from "../src/exploration-markers.js";
import {
  cloneStackData,
  normalizeMapTarget,
  normalizeStackData,
  normalizeStackDataSchema,
  stackDataIdentity,
} from "../src/item-stack-data.js";
import { ITEM } from "../src/items.js";
import {
  MAX_STRUCTURE_ID_LENGTH as PROGRESSION_STRUCTURE_LIMIT,
  MAX_STRUCTURE_MEMBER_ID_LENGTH as PROGRESSION_MEMBER_LIMIT,
  normalizeProgressContext,
  progressId,
  progressStructureId,
} from "../src/progression-common.js";
import {
  describeStructure,
  getStructureMarkers,
  resolveStructureMapTarget,
  STRUCTURE_KINDS,
  STRUCTURE_LIMITS,
  structureTarget,
} from "../src/structure-catalog.js";
import { normalizeWorldSave } from "../src/world-edits.js";
import { createWorldContext } from "../src/world-spec.js";
import { authoredColumn, authoredContext } from "./structure-fixtures.js";

// Real catalog descriptors over authored column fields. No item registration,
// loot rolls, World instances, inventory authority, or fabricated map item IDs.
function fixture(
  kind = "buried_treasure",
  seed = "map-identity-fixture",
  { gx = -8, width = 16, matches = () => true } = {}
) {
  const { context: terrainContext } = authoredContext(kind, seed);
  const context = createWorldContext({ seed, generatorVersion: 4 });
  for (let z = -8; z < 8; z++) {
    for (let x = gx; x < gx + width; x++) {
      const descriptor = describeStructure(kind, terrainContext, x, z);
      if (!descriptor || !matches(descriptor)) continue;
      const target = structureTarget(descriptor);
      return {
        descriptor,
        terrainContext,
        context,
        target: {
          seed,
          generatorVersion: descriptor.generatorVersion,
          dimension: target.dimension,
          structureId: target.id,
          ...target.position,
        },
      };
    }
  }
  assert.fail(`Bounded authored catalog search did not select ${kind}`);
}

for (const [label, seed] of [
  ["ordinary quoted seed", "ordinary-seed"],
  ["URI punctuation and literal escapes", "seed:\"%22/%E9:!'()*?"],
  ["mixed Unicode", "宝藏 é 🐠"],
  ["maximum ASCII", "a".repeat(80)],
  ["maximum BMP expansion", "雪".repeat(80)],
  ["maximum astral seed", "🐠".repeat(40)],
  ["maximum JSON escaping", '"\\'.repeat(40)],
  ["empty World seed", ""],
  ["whitespace World seed", " \t\n"],
  ["control-bearing World seed", "world\u0000\r\nseed"],
  ["format-character World seed", "world\u202eseed"],
  ["lone high surrogate", "\ud800"],
  ["lone low surrogate", "\udfff"],
  ["maximal escaped code units", "\ud800".repeat(80)],
]) {
  test(`canonical map roundtrip: ${label}`, () => {
    const { descriptor, context, target } = fixture("buried_treasure", seed);
    assert.ok(
      target.structureId.includes(encodeURIComponent(JSON.stringify(seed)))
    );
    assert.ok(target.structureId.length <= MAX_STRUCTURE_ID_LENGTH);
    assert.deepEqual(normalizeMapTarget(target), target);
    assert.deepEqual(normalizeMapTarget(target, context), target);
    assert.deepEqual(normalizeTreasureMapTarget(target, context), target);
    assert.equal(
      progressStructureId(descriptor.id, descriptor.dimension, context),
      descriptor.id
    );
    const data = { version: 1, mapTarget: target };
    assert.deepEqual(
      normalizeStackData(ITEM.TREASURE_MAP, data, context),
      data
    );
    const normalized = normalizeStackDataSchema(data, context);
    const cloned = cloneStackData(normalized, context);
    assert.deepEqual(cloned, data);
    assert.notEqual(cloned, data);
    assert.notEqual(cloned.mapTarget, target);
    assert.equal(cloned.mapTarget.structureId, descriptor.id);
    assert.equal(
      JSON.parse(stackDataIdentity(data, context)).mapTarget.structureId,
      descriptor.id
    );
    assert.deepEqual(
      normalizeStackDataSchema(JSON.parse(JSON.stringify(normalized)), context),
      data
    );
    cloned.mapTarget.x++;
    assert.equal(target.x, descriptor.origin.x);
    assert.equal(normalized.mapTarget.x, descriptor.origin.x);
  });
}

test("progression follows the exact World seed contract without relaxing names or opaque IDs", () => {
  for (const seed of ["", " ", "\u0000", "x\u202e", "\ud800"]) {
    for (const generatorVersion of [1, 2, 3, 4]) {
      const world = normalizeWorldSave({
        version: 3,
        seed,
        generatorVersion,
        dimension: "overworld",
        edits: [],
      });
      const context = normalizeProgressContext(createWorldContext(world));
      assert.equal(context.seed, seed);
      assert.equal(context.generatorVersion, generatorVersion);
    }
    assert.throws(() => progressId(seed), RangeError);
    assert.throws(
      () => normalizeStackDataSchema({ version: 1, name: seed }),
      RangeError
    );
  }
  for (const seed of [null, undefined, {}, new String("seed"), "x".repeat(81)])
    assert.throws(
      () => normalizeProgressContext({ seed, generatorVersion: 4 }),
      RangeError
    );
});

test("the shared versioned grammar matches every actual catalog kind and dimension", () => {
  assert.equal(PROGRESSION_STRUCTURE_LIMIT, MAX_STRUCTURE_ID_LENGTH);
  assert.equal(PROGRESSION_MEMBER_LIMIT, MAX_STRUCTURE_MEMBER_ID_LENGTH);
  for (const kind of STRUCTURE_KINDS) {
    const { descriptor, context, target } = fixture(kind);
    const owner = parseStructureIdentity(
      descriptor.id,
      descriptor.seed,
      descriptor.generatorVersion,
      descriptor.dimension
    );
    assert.deepEqual(owner, {
      layoutVersion: descriptor.layoutVersion,
      generatorVersion: descriptor.generatorVersion,
      dimension: descriptor.dimension,
      kind,
      gx: descriptor.gx,
      gz: descriptor.gz,
      spacing: STRUCTURE_LIMITS.spacing,
    });
    assert.deepEqual(normalizeMapTarget(target, context), target);
    assert.equal(
      progressStructureId(descriptor.id, descriptor.dimension, context),
      descriptor.id
    );
  }
});

test("catalog marker/locator projection and the stack schema accept the same complete map reference", () => {
  const f = fixture("shipwreck", "雪".repeat(80), {
    matches: (d) =>
      d.markers.some((marker) => marker.table === "shipwreck/map"),
  });
  const raw = getStructureMarkers(f.descriptor, { type: "container" }).find(
    (marker) => marker.table === "shipwreck/map"
  );
  const marker = explorationMarkerFromStructure(f.descriptor, raw, f.context);
  const beach = authoredColumn("buried_treasure");
  const terrainContext = {
    ...f.terrainContext,
    sampleColumn(x, z) {
      return Math.floor(x / STRUCTURE_LIMITS.spacing) === f.descriptor.gx &&
        Math.floor(z / STRUCTURE_LIMITS.spacing) === f.descriptor.gz
        ? f.terrainContext.sampleColumn(x, z)
        : beach;
    },
  };
  const result = resolveStructureMapTarget(raw.mapTarget, terrainContext);
  const projected = mapResolutionFromStructure(result, f.context);
  assert.ok(projected.target);
  const selected = selectTreasureMapTarget(
    marker,
    [projected.target],
    f.context
  );
  const described = describeStructure(
    "buried_treasure",
    terrainContext,
    result.target.gx,
    result.target.gz
  );
  assert.equal(selected.structureId, described.id);
  assert.ok(selected.structureId.length > 128);
  assert.deepEqual(normalizeMapTarget(selected, f.context), selected);
  assert.deepEqual(
    normalizeStackDataSchema({ version: 1, mapTarget: selected }, f.context)
      .mapTarget,
    normalizeTreasureMapTarget(selected, f.context)
  );
});

test("legacy opaque IDs retain their exact grammar, length, dimensions and historical versions", () => {
  const { context, target } = fixture();
  for (const structureId of [
    "v4:overworld:village:-2,5",
    "fixture:buried/treasure-1",
    "A0_./,:-z",
    "structure",
    "x".repeat(128),
  ]) {
    const legacy = { ...target, structureId, x: -25, z: 80 };
    assert.equal(parseStructureIdentity(structureId), null);
    assert.equal(
      progressStructureId(structureId, legacy.dimension, context),
      structureId
    );
    assert.deepEqual(normalizeMapTarget(legacy, context), legacy);
    for (const generatorVersion of [1, 2, 3, 4]) {
      for (const dimension of ["overworld", "nether", "end"]) {
        const historical = { ...legacy, generatorVersion, dimension, y: 1 };
        assert.deepEqual(normalizeMapTarget(historical), historical);
      }
    }
  }
  for (const structureId of [
    "",
    "x".repeat(129),
    "with space",
    "fixture:%22seed%22",
    "宝藏",
    "a\u0000b",
    {},
    new String("legacy"),
    null,
    undefined,
  ]) {
    assert.throws(() => parseStructureIdentity(structureId), RangeError);
    assert.throws(
      () => normalizeMapTarget({ ...target, structureId }, context),
      RangeError
    );
    assert.throws(
      () => progressStructureId(structureId, target.dimension, context),
      RangeError
    );
  }
  assert.equal(progressId("npc:village/member-1"), "npc:village/member-1");
  assert.throws(() => progressId(target.structureId), RangeError);
  assert.throws(() => progressId("npc:%22member%22"), RangeError);
  assert.throws(() => progressId("n".repeat(193)), RangeError);
});

test("malformed canonical IDs never fall back to the short legacy grammar", () => {
  const { descriptor, context, target } = fixture("buried_treasure", "雪");
  const prefix = descriptor.id.split(":").slice(0, -2).join(":");
  for (const structureId of [
    "structure:legacy-looking",
    "structure:v1:seed:overworld:buried_treasure:0:0",
    descriptor.id.replace("structure:v1:", "structure:v2:"),
    descriptor.id.replace("structure:v1:", "structure:v01:"),
    descriptor.id.replace("%E9", "%e9"),
    descriptor.id.replace("%22", "%2522"),
    descriptor.id.replace("%E9", "%ZZ"),
    descriptor.id.replace(":buried_treasure:", ":unknown_kind:"),
    descriptor.id.replace(":buried_treasure:", ":__proto__:"),
    `${descriptor.id}/container/heart`,
    `${descriptor.id}:extra`,
    `${descriptor.id}${"x".repeat(MAX_STRUCTURE_ID_LENGTH)}`,
    ...[
      "00",
      "+0",
      "-0",
      "1e0",
      "1.0",
      "NaN",
      "9007199254740992",
      "-156251",
      "156250",
    ].flatMap((coordinate) => [
      `${prefix}:${coordinate}:${descriptor.gz}`,
      `${prefix}:${descriptor.gx}:${coordinate}`,
    ]),
  ]) {
    assert.throws(
      () =>
        parseStructureIdentity(
          structureId,
          target.seed,
          target.generatorVersion,
          target.dimension
        ),
      RangeError
    );
    assert.throws(
      () => normalizeMapTarget({ ...target, structureId }, context),
      RangeError
    );
    assert.throws(
      () => progressStructureId(structureId, target.dimension, context),
      RangeError
    );
  }
});

test("canonical references reject foreign worlds even when no external context is supplied", () => {
  const { context, target } = fixture();
  for (const patch of [
    { seed: "another-world" },
    { generatorVersion: 3 },
    { generatorVersion: "4" },
    { dimension: "nether" },
    { dimension: "end" },
    {
      dimension: "nether",
      structureId: target.structureId.replace(":overworld:", ":nether:"),
    },
  ]) {
    assert.throws(
      () => normalizeMapTarget({ ...target, ...patch }),
      RangeError
    );
    assert.throws(
      () => normalizeMapTarget({ ...target, ...patch }, context),
      RangeError
    );
    assert.throws(
      () => normalizeTreasureMapTarget({ ...target, ...patch }, context),
      RangeError
    );
  }
  assert.throws(
    () => normalizeMapTarget(target, { seed: "foreign" }),
    RangeError
  );
  assert.throws(
    () => normalizeMapTarget(target, { generatorVersion: 3 }),
    RangeError
  );
  const foreign = fixture("buried_treasure", "foreign").target;
  assert.deepEqual(normalizeMapTarget(foreign), foreign);
  assert.throws(() => normalizeMapTarget(foreign, context), RangeError);
  assert.throws(
    () => progressStructureId(foreign.structureId, foreign.dimension, context),
    RangeError
  );
  for (const seed of [
    "",
    " ",
    "x".repeat(81),
    "x\n",
    "x\u0000",
    "x\u202e",
    "\ud800",
  ]) {
    assert.throws(() => normalizeMapTarget({ ...target, seed }), RangeError);
    assert.throws(
      () =>
        parseStructureIdentity(target.structureId, seed, 4, target.dimension),
      RangeError
    );
  }
});

test("canonical owner checks are half-open at negative cells and both world edges", () => {
  for (const gx of [-156250, -1, 0, 156249]) {
    const { descriptor, context, target } = fixture(
      "buried_treasure",
      "owner-edges",
      {
        gx,
        width: 1,
      }
    );
    const minX = descriptor.gx * STRUCTURE_LIMITS.spacing;
    const minZ = descriptor.gz * STRUCTURE_LIMITS.spacing;
    const last = STRUCTURE_LIMITS.spacing - 1;
    for (const position of [
      { x: minX, z: minZ },
      { x: minX + last, z: minZ + last },
    ]) {
      const at = { ...target, ...position };
      assert.deepEqual(normalizeMapTarget(at, context), at);
      assert.deepEqual(normalizeTreasureMapTarget(at, context), at);
    }
    for (const position of [
      { x: minX - 1 },
      { x: minX + STRUCTURE_LIMITS.spacing },
      { z: minZ - 1 },
      { z: minZ + STRUCTURE_LIMITS.spacing },
    ]) {
      assert.throws(
        () => normalizeMapTarget({ ...target, ...position }, context),
        RangeError
      );
      assert.throws(
        () => normalizeTreasureMapTarget({ ...target, ...position }, context),
        RangeError
      );
    }
    const ownerParts = descriptor.id.split(":");
    ownerParts[5] = String(gx === 156249 ? gx - 1 : gx + 1);
    const changedOwner = { ...target, structureId: ownerParts.join(":") };
    assert.equal(
      progressStructureId(changedOwner.structureId, target.dimension, context),
      changedOwner.structureId
    );
    assert.throws(() => normalizeMapTarget(changedOwner, context), RangeError);
    assert.throws(
      () => normalizeTreasureMapTarget(changedOwner, context),
      RangeError
    );
  }
});

test("map targets retain strict integer/world bounds and use the target dimension specification", () => {
  const overworld = fixture();
  const nether = fixture("nether_fortress");
  for (const f of [overworld, nether]) {
    const spec = f.context.specForDimension(f.target.dimension);
    for (const y of [spec.minY, spec.maxY - 1])
      assert.equal(normalizeMapTarget({ ...f.target, y }, f.context).y, y);
    for (const patch of [
      { y: spec.minY - 1 },
      { y: spec.maxY },
      { y: NaN },
      { y: "1" },
      { x: 0.5 },
      { z: Infinity },
      { x: -30_000_001 },
      { z: 30_000_000 },
    ]) {
      assert.throws(
        () => normalizeMapTarget({ ...f.target, ...patch }, f.context),
        RangeError
      );
    }
  }
  const dimensions = [];
  assert.deepEqual(
    normalizeMapTarget(nether.target, {
      ...nether.context,
      specForDimension(dimension) {
        dimensions.push(dimension);
        return nether.context.specForDimension(dimension);
      },
    }),
    nether.target
  );
  assert.deepEqual(dimensions, ["nether"]);
  assert.throws(
    () =>
      normalizeMapTarget(nether.target, {
        ...nether.context,
        specForDimension: () => null,
      }),
    RangeError
  );
});

test("map records reject accessors, hidden fields, prototypes and unknown data before reading them", () => {
  const { context, target } = fixture();
  const nullPrototype = Object.assign(Object.create(null), target);
  assert.deepEqual(normalizeMapTarget(nullPrototype, context), target);
  let invoked = false;
  for (const field of ["seed", "structureId", "x"]) {
    const accessor = { ...target };
    Object.defineProperty(accessor, field, {
      enumerable: true,
      get() {
        invoked = true;
        return target[field];
      },
    });
    assert.throws(() => normalizeMapTarget(accessor, context), RangeError);
    assert.equal(invoked, false);
  }
  const outerAccessor = { version: 1 };
  Object.defineProperty(outerAccessor, "mapTarget", {
    enumerable: true,
    get() {
      invoked = true;
      return target;
    },
  });
  assert.throws(
    () => normalizeStackDataSchema(outerAccessor, context),
    RangeError
  );
  assert.equal(invoked, false);
  for (const value of [
    null,
    [],
    new Date(),
    Object.assign(Object.create({ inherited: true }), target),
    Object.defineProperty({ ...target }, "hidden", { value: true }),
    { ...target, [Symbol("hidden")]: true },
    { ...target, arbitrary: {} },
    {
      ...target,
      structureId: {
        toString() {
          assert.fail("No coercion");
        },
      },
    },
  ]) {
    assert.throws(() => normalizeMapTarget(value, context), RangeError);
  }
});

test("schema identity retains complete seed/owner/coordinate differences without normalizing Unicode", () => {
  const keys = [];
  for (const seed of [
    "é",
    "e\u0301",
    "雪".repeat(79) + "甲",
    "雪".repeat(79) + "乙",
  ]) {
    const { context, target } = fixture("buried_treasure", seed);
    const data = { version: 1, mapTarget: target };
    const reversed = {
      mapTarget: Object.fromEntries(Object.entries(target).reverse()),
      version: 1,
    };
    const key = stackDataIdentity(data, context);
    keys.push(key);
    assert.equal(stackDataIdentity(reversed, context), key);
    assert.equal(JSON.parse(key).mapTarget.structureId, target.structureId);
    assert.equal(JSON.parse(key).mapTarget.seed, seed);
    assert.notEqual(
      stackDataIdentity(
        {
          version: 1,
          mapTarget: { ...target, x: target.x + 1 },
        },
        context
      ),
      key
    );
  }
  assert.equal(new Set(keys).size, keys.length);
});

test("schema acceptance does not grant map capability or weaken unsupported metadata rejection", () => {
  const { context, target } = fixture("buried_treasure", "雪".repeat(80));
  const data = { version: 1, mapTarget: target };
  assert.deepEqual(normalizeStackDataSchema(data, context), data);
  assert.throws(
    () => normalizeStackData(ITEM.APPLE, data, context),
    /Ineligible map metadata/
  );
  for (const invalid of [
    { ...data, version: 2 },
    { ...data, mapTarget: null },
    { ...data, arbitrary: {} },
    { ...data, enchantments: { unknown_enchantment: 1 } },
    { ...data, mapTarget: { ...target, loot: [] } },
  ]) {
    assert.throws(() => normalizeStackDataSchema(invalid, context), RangeError);
  }
  // Inventory transfer and archive ownership remain integration concerns.
  // Real TREASURE_MAP eligibility is exercised by the seed roundtrips above.
});
