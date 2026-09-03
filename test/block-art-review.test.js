import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BLOCK, BLOCK_CATALOG } from "../src/blocks.js";
import { isValidCell } from "../src/block-state.js";
import { blockTexturePixels, tileFor } from "../src/textures.js";
import {
  casesFor,
  CATALOG_GROUPS,
  facePartsFor,
  fixtureWorld,
  groupFor,
  MAX_CASES_PER_BLOCK,
  MAX_CELLS_PER_CASE,
  PAGE_SIZE,
  requiredCapturesFor,
  resolvedSubjects,
  specialAccounting,
  SYMBOLS,
} from "./block-art-review/cases.js";
import {
  CAPTURE_KIND,
  catalogAudit,
  CRITERIA,
  parseManifest,
  reviewAudit,
  SURFACES,
} from "./block-art-review/coverage.js";
import { captureQueue, pageCounts, readSelection, sheetPlan } from "./block-art-review/plan.js";

const manifest = parseManifest(await readFile(
  new URL("../docs/block-art-review.md", import.meta.url), "utf8",
));
const freshRows = () => BLOCK_CATALOG.map(({ id }) => ({
  id, symbol: SYMBOLS.get(id), status: "unreviewed", review: "-",
}));
const fingerprint = "f".repeat(64);
const keyFor = ({ case: key, light, labels }) => `${key}/${light}/${labels}`;

test("review manifest accounts for every live ID exactly, including sparse and special cells", () => {
  const audit = catalogAudit(manifest);
  assert.deepEqual(audit.errors, []);
  assert.deepEqual(manifest.map(({ id }) => id), BLOCK_CATALOG.map(({ id }) => id));
  assert.ok(manifest.some(({ id }) => id === BLOCK.AIR));
  assert.ok(manifest.some(({ id }) => id > 1024));
  for (const id of [BLOCK.AIR, BLOCK.WATER, BLOCK.LAVA, BLOCK.NETHER_PORTAL, BLOCK.END_PORTAL])
    assert.ok(specialAccounting(id));
  assert.equal(specialAccounting(BLOCK.STONE), null);
});

test("new, omitted, duplicated and misnamed blocks invalidate catalog completeness", () => {
  assert.match(catalogAudit(freshRows().slice(1)).errors.join("\n"), /missing catalog ID 0/);
  assert.match(catalogAudit([...freshRows(), freshRows()[0]]).errors.join("\n"), /Duplicate/);
  const renamed = freshRows();
  renamed[1].symbol = "WRONG_IDENTITY";
  assert.match(catalogAudit(renamed).errors.join("\n"), /Identity mismatch/);
  const future = [...BLOCK_CATALOG, { id: 65534, name: "Future registry block" }];
  assert.match(catalogAudit(freshRows(), future).errors.join("\n"), /65534/);
  assert.throws(() => parseManifest("Everything looks good"), /Missing/);
});

test("all block faces and multipart faces call the real deterministic texture/atlas dispatcher", () => {
  const occupiedTiles = new Set();
  for (const { id, name } of BLOCK_CATALOG) {
    assert.ok(facePartsFor(id).length >= 3, name);
    const tiles = new Set();
    for (const { face, part } of facePartsFor(id)) {
      const pixels = blockTexturePixels(id, face, part ?? undefined);
      assert.equal(pixels.length, 16 * 16 * 4);
      assert.deepEqual(pixels, blockTexturePixels(id, face, part ?? undefined));
      const tile = tileFor(id, face, part ?? undefined);
      assert.ok(Number.isSafeInteger(tile) && tile >= 0);
      tiles.add(tile);
      const visible = pixels.some((value, index) => index % 4 === 3 && value > 0);
      assert.equal(visible, id !== BLOCK.AIR, `${name}/${part}/${face}`);
    }
    for (const tile of tiles) {
      assert.equal(occupiedTiles.has(tile), false, `${name} must have its own atlas allocation`);
      occupiedTiles.add(tile);
    }
  }
});

test("every profile is bounded and uses valid linked/supported production cells", () => {
  for (const block of BLOCK_CATALOG) {
    const cases = casesFor(block.id);
    assert.ok(cases.length > 0 && cases.length <= MAX_CASES_PER_BLOCK, block.name);
    assert.equal(new Set(cases.map(({ key }) => key)).size, cases.length);
    for (const reviewCase of cases) {
      assert.ok(reviewCase.cells.length <= MAX_CELLS_PER_CASE);
      assert.ok(reviewCase.cells.every(isValidCell), `${block.name}/${reviewCase.key}`);
      assert.ok(reviewCase.cells.some(({ role, id }) => role === "subject" && id === block.id));
      const { cells } = fixtureWorld(reviewCase);
      assert.equal(cells.size, reviewCase.cells.length);
      for (const shape of resolvedSubjects(reviewCase)) {
        if (shape.link) assert.equal(shape.link.valid, true, `${block.name}/${reviewCase.key}`);
        if (shape.attachment) assert.equal(shape.attachment.valid, true, `${block.name}/${reviewCase.key}`);
        if (block.shape === "stairs" && /^(?:top-)?(?:inner|outer)-/.test(reviewCase.key))
          assert.equal(shape.corner, reviewCase.key.replace(/^top-/, "").replace("-", "_"));
      }
    }
  }
  assert.equal(resolvedSubjects(casesFor(BLOCK.AIR)[0])[0].render.length, 0);
});

test("groups and canonical pages cover all IDs once without collapsing shared wood art", () => {
  const ids = [];
  for (const group of CATALOG_GROUPS) {
    for (let page = 0; page < pageCounts({ group }); page++) {
      const plan = sheetPlan({ group, page });
      assert.ok(plan.cases.length > 0 && plan.cases.length <= PAGE_SIZE);
      ids.push(...plan.cases.map(({ id }) => id));
    }
  }
  assert.deepEqual(ids.sort((a, b) => a - b), BLOCK_CATALOG.map(({ id }) => id));
  assert.equal(groupFor(BLOCK_CATALOG.find(({ id }) => id === BLOCK.OAK_SLAB)), "wood-oak");
  assert.ok(ids.includes(BLOCK.OAK_SLAB) && ids.includes(BLOCK.BIRCH_SLAB));
});

test("the deterministic capture queue covers the full declared per-ID evidence matrix", () => {
  const observed = new Map(BLOCK_CATALOG.map(({ id }) => [id, new Set()]));
  for (const selection of captureQueue()) {
    const plan = sheetPlan(selection);
    for (const { id, key } of plan.cases)
      observed.get(id).add(keyFor({ ...selection, case: key }));
  }
  for (const { id, name } of BLOCK_CATALOG)
    for (const required of requiredCapturesFor(id))
      assert.ok(observed.get(id).has(keyFor(required)), `${name}/${keyFor(required)}`);
});

test("blind ordering is seeded, reproducible, answer-keyed separately and strictly bounded", () => {
  const a = sheetPlan({ group: "ores", seed: "critic-a", labels: "blind" });
  const b = sheetPlan({ group: "ores", seed: "critic-a", labels: "labeled" });
  assert.deepEqual(a.cases, b.cases);
  assert.deepEqual(a.cases, sheetPlan(a.selection).cases);
  assert.deepEqual(a.cases.map(({ token }) => token), [
    "Sample A", "Sample B", "Sample C", "Sample D", "Sample E", "Sample F",
  ]);
  for (const options of [
    { page: -1 }, { page: 99999 }, { group: "missing" },
    { light: "fullbright" }, { labels: "approve" }, { ids: "3,3" },
    { ids: "3," }, { ids: "65534" }, { ids: "0,1,2,3,4,5,6" },
    { ids: "3", group: "ores" },
  ]) assert.throws(() => sheetPlan(options), RangeError);
  assert.throws(() => readSelection({ seed: "../outside" }), RangeError);
});

test("rendering/passing pixel tests or writing blanket approved rows cannot complete review", () => {
  const empty = { schemaVersion: 1, records: [] };
  const unreviewed = reviewAudit(freshRows(), empty, new Map(), fingerprint);
  assert.deepEqual(unreviewed.errors, []);
  assert.equal(unreviewed.complete, false);
  const approved = freshRows().map((row) => ({ ...row, status: "approved", review: "blanket" }));
  const attempted = reviewAudit(approved, empty, new Map(), fingerprint);
  assert.equal(attempted.complete, false);
  assert.equal(attempted.errors.length, BLOCK_CATALOG.length);
});

// Policy-only metadata fixture: no mock pixel assets, browser captures, images,
// files or real review claims are produced by this unit test.
function decisionFixture(id = BLOCK.STONE) {
  const captures = new Map();
  const paths = [];
  for (const required of requiredCapturesFor(id)) {
    const path = `/policy-test/${id}/${keyFor(required)}/capture.json`;
    paths.push(path);
    captures.set(path, {
      kind: CAPTURE_KIND, schemaVersion: 1, verifiedArtifact: true,
      createdAt: "2026-09-03T00:00:00Z", errors: [],
      snapshot: {
        build: { sourceFingerprint: fingerprint },
        selection: required,
        cases: [{
          id, key: required.case, faceParts: facePartsFor(id), surfaces: [...SURFACES],
          frames: [0, 1, 2].map(() => ({ glError: 0, contextLost: false, failedPrograms: 0 })),
        }],
      },
    });
  }
  const blindCapture = paths.find((path) => path.includes("/blind/"));
  const record = {
    id, key: `individual-${id}`, sourceFingerprint: fingerprint,
    captures: paths, openFindings: [],
    critics: ["blind", "adversarial"].map((role) => ({
      reviewer: `policy-test-${role}`, role,
      reviewedAt: "2026-09-03T01:00:00Z",
      labelsRevealedAt: "2026-09-03T02:00:00Z",
      blindCapture, initialGuess: "Policy test only",
      nearestConfusableId: BLOCK.COBBLESTONE,
      comparison: "Policy schema comparison, not a real visual judgment.",
      criteria: Object.fromEntries(CRITERIA.map((criterion) => [criterion, {
        verdict: "pass", note: `Policy fixture for ${criterion}; this is not visual evidence.`,
        evidence: paths,
      }])),
    })),
  };
  const rows = freshRows();
  Object.assign(rows.find((row) => row.id === id), { status: "approved", review: record.key });
  return { rows, record, decisions: { schemaVersion: 1, records: [record] }, captures };
}

test("individual approvals require current artifacts, independent critics and complete state evidence", () => {
  const fixture = decisionFixture();
  const audit = () => reviewAudit(fixture.rows, fixture.decisions, fixture.captures, fingerprint);
  assert.deepEqual(audit().errors, []);
  assert.equal(audit().complete, false, "all other live IDs still need their own reviews");
  fixture.record.critics[1].reviewer = fixture.record.critics[0].reviewer;
  assert.match(audit().errors.join("\n"), /independent/);
  fixture.record.critics[1].reviewer = "policy-test-second";
  fixture.record.critics[0].labelsRevealedAt = "2026-09-03T00:30:00Z";
  assert.match(audit().errors.join("\n"), /before label reveal/);
  fixture.record.critics[0].labelsRevealedAt = "2026-09-03T02:00:00Z";
  fixture.record.sourceFingerprint = "stale";
  assert.match(audit().errors.join("\n"), /stale review/);
  fixture.record.sourceFingerprint = fingerprint;
  const first = fixture.captures.values().next().value;
  first.verifiedArtifact = false;
  assert.match(audit().errors.join("\n"), /PNG hash/);
  first.verifiedArtifact = true;
  first.snapshot.cases[0].faceParts = [];
  assert.match(audit().errors.join("\n"), /face\/part/);
  first.snapshot.cases[0].faceParts = facePartsFor(BLOCK.STONE);
  fixture.record.captures.pop();
  assert.match(audit().errors.join("\n"), /missing repeat-2x2x2/);
});
