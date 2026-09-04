# Expanded v7 integration and acceptance

Explicit v7 is wired through the production factory; **the new-world default
switch and visual acceptance are still pending**.
The normal default stays 3 until the parent completes the gates below. Final
ordinary new worlds must use expanded v7, not a new 96-high variant or a hidden
selector. Explicit saved versions 1–6 must continue dispatching unchanged.

## Source and compatibility evidence

- Immutable v6 source: `6c3790183176f60d6fd15cb6253838d5c3d8eb61`,
  `/tmp/mineslop-environment-repaired-checkpoint` (capture requires a clean tree).
- `terrain-v6-golden.json`: 129 chunks, three seeds, all dimensions, native
  eight-family structure chunks, signed/distant/edge coordinates and v6 seams.
  Canonical fixture digest:
  `7326762cdb8830b8654f0281e8571de6017863a5f8ba7a017757ad6abedeabae`.
- `terrain-v7-golden.json`: 462 chunks, metadata, specs/spawns, outlines,
  integer-grid hollow spill levels and eight-family native declarations.
  Source-file digests identify the uncommitted v7 policy; no invented commit SHA.
  Canonical fixture digest:
  `bb04440f58a1751ea9e60457ea694facb70b97e84502325464b22f13019363ff`.
- Capture scripts are manual tools; tests read static JSON, never generate
  expected values at assertion time. Earlier golden files remain untouched.
- Overworld field/vegetation, expanded specs, Nether and End outside radius256
  reuse frozen v6 behavior. Native layout-v1 descriptors deliberately carry7;
  their blocks, states, fluids and biome planes retain the v6 policy.

## Shared factory integration

The parent has wired the following dispatch in `terrain.js`, preserving the
LOD owner's separate legacy landmark API changes:

```js
import { createNativeTerrainV7 } from "./terrain-v7.js";
// In createGenerator, after normalizing seedString and validating dimension:
if (generatorVersion === 7) return createNativeTerrainV7(seedString, dimension);
```

No Game/Player/renderer changes are included here. The native factory
already attaches the v7 generation manifest. It retains version7 on nested
cross-dimension construction. Do not change the version-6 factory or field.

The v7 native worker/World/save tests now use normal production dispatch with
no `generatorFactory` injection. The redundant `v7Factory` wrapper is removed.
V7 generation and static-golden tests call `createGenerator(...,7)` directly;
the manifest assertion covers Overworld, Nether and End. The custom-decorator
unit test deliberately retains `createTerrainV7` to observe nested version
contexts. Pure field/landmark unit tests remain independent of the shared
factory. No golden values or generation policies change in this integration.

Shared-factory verification on 2026-09-04: **215/215 focused tests pass** with
`--test-concurrency=1`, covering v7 generation/goldens/native admission/saves,
versioned transport, World admission events, and immutable1–6 generation.
The run includes all462 static v7 chunks and all129 immutable v6 chunks.
Evidence: `/opt/cursor/artifacts/mineslop_v7_shared_factory_acceptance_20260904.tap`.
This verifies Node worker-handler and World fallback dispatch, not browser
module-worker execution or visual acceptance.

After acceptance, the ordinary-new-world hook is the exported
`GENERATOR_VERSION` in `terrain.js`: `Game.newWorld` → `GameTravel.generate` →
`game.initialize(seed,null,...)` → `stageWorld` uses that default.
`game-world-stage.js` already prefers `saved.world.generatorVersion` for loads,
and `World.setDimension` retains its current version. Do not replace either
saved-version branch with the new default. Update only default assertions in
`terrain.test.js`, `world-foundation.test.js`, `world.integration.test.js`,
`world-admission-events.test.js`, `terrain-v5-generation.test.js`,
`terrain-v6-generation.test.js`, `terrain-v7-generation.test.js` and the
v5/v6/v7 save integration tests. Keep their explicit historical3 assertions
and historical golden expectations; use explicit version3 construction where
an old-world test currently relies on the default.

## Pure native geometry contract

`generator.getEndPillars()` returns a stable frozen array of ten descriptors only
for v7 End (empty for other v7 dimensions). Each descriptor retains the current
legacy API fields `id,x,z,base,top` and adds:

- `generatorVersion:7`, `dimension:"end"`.
- `body.block`, `body.minY` inclusive, `body.maxY` exclusive.
- `body.columns`: frozen `[dx,dz]` voxel offsets; authoritative 21-column mask.
- `body.columnMask`: 25 bits, row-major with bit `(dz+2)*5+dx+2`.
- `body.blockCount`: exact generated obsidian count.
- `cap:{block,x,y,z}`: exact one-voxel cap at `top+1`.

Both the writer and metadata use the same footprint and height plan. No separate
renderer placement formula is needed. The LOD consumer must use this geometry,
clip to `world.spec` instead of historical Y96, and retain its edit/coverage/
section ownership logic. The current legacy `{id,x,z,base,top}` consumer needs
that expansion before v7 can pass visual gates. Do not report v4–6 pillars: their
native End has none. Legacy1–3 descriptor exposure remains the LOD owner's work.

The caps are original procedural glowstone blocks, not functional End crystals.
There is **no fountain, fake portal, or new return-portal capability**. Functional
return travel is separate scope requiring real portal/safe-arrival integration.

## Measured visual checkpoints (x,y,z)

`cedar-valley`, v7 End:

- Spawn `(0.5,79.01,0.5)` on a solid pad, with two air cells.
- Bowl centers `(-15,68,60)`, `(-43,65,-41)`, `(59,60,-17)`.
- Lowest integer-grid escape levels Y86, Y81, Y82: enclosed depths18,16,22.
- Central outline radii173–216 across 32 bearings.
- Ten pillar caps at Y106–125, 7,224 obsidian blocks and ten cap blocks.
- Native pillar0 `(92,76,55)` base, cap `(92,114,55)`.
- Opposite pillar5 `(-93,76,-56)` base, cap `(-93,118,-56)`.
- Seed `mineslop-audit-2`: bowl depths21,13,16, outline164–216,
  8,442 obsidian, capsY104–130.
- Empty seed: bowl depths23,20,18, outline169–215,
  7,665 obsidian, capsY105–132.
- Outer controls start at `(-592,-784)`, `(-128,-816)`, `(512,0)` and
  `(1600,-2048)` in XZ; v6/v7 sampled columns and 16×16 regions match exactly.
  Respectively: highland top137/bottom86; barrens top47/bottom43; void;
  small island top56/bottom50. The highland exceeds the historical Y96 volume.

The hollow tests find the minimum maximum elevation over **all** escape paths
in a bounded integer grid; they do not substitute standard deviation for real
enclosure. Route tests find one-block-step cardinal paths from spawn to all
three bowl floors and all ten pillar approaches, excluding occupied pillar
columns. They validate natural floor and two-cell headroom along those paths.

## Bounded gates before ordinary-new-world activation

1. Shared factory is wired; explicit1–7 worker contexts alternate and reject8
   through the normal worker handler, without a replacement factory.
   Run static1–6 goldens, v7 goldens, native transport/admission and save tests
   sequentially. Schema remains archive3/chunk2/layout1. Foreign maps, sidecars
   and native descriptors must reject even when structure-ID strings coincide.
2. Run actual browser module-worker and main-thread fallback with v7 at
   pillar0, pillar5, one bowl, one native Overworld structure and one Nether
   structure. Confirm full cell planes, declarations, edits and unload/reload
   parity. Node handler/fallback coverage does not replace this actual browser
   module-worker and GUI gate.
3. Parent's full native ecology/performance gates: every dimension retains
   correct bounds, native aquatic/structure population, safe spawn, held items,
   lighting and collision. Scalar LOD queries must not generate chunks/voxels.
4. Bounded GUI acceptance, no screenshot-only stand-in for native geometry:
   overview from roughly `(0,165,260)` looking at `(0,85,0)`, distance≥512,
   verify ten complete pillars/caps and irregular outline in one view; native
   detail/LOD approach through pillar0 and pillar5; bowl-floor/rim walk at the
   first two centers; underside flyby and preserved outer controls.
   Repeat overview after reload and at low/high quality.
5. Edit/remove a cap and part of one pillar, unload/reload the column, and
   compare detail/LOD without stale voxels, duplicates or holes. Check frustum/
   section handoff counts against the authoritative voxel masks. Load v4–6 End
   saves and confirm no phantom pillars. Load1–3 saves and confirm old voxels.
6. Only after these pass, switch ordinary new-world construction to7 and update
   new-world default tests in the parent-owned Game/startup flow. Keep explicit
   versioned saves pinned and run import/export, IndexedDB reload, dimension
   round trips, death/respawn and any functional return-portal arrival tests.

Generation-only tests deliberately do not claim GUI/LOD acceptance or a working
return portal.

## Parent-run real-browser gate (validated on frozen source)

The parent-run clean r4 Vite build and headless browser gate pass on source
`6ea12b135d8e30d8434b4f5156ab5bd08c417478`, build label
`v7-clean-staging-r4-20260904`, served at
`http://127.0.0.1:6553/test/terrain-v7-worker.html`.
The supplied TAP confirms five transport cases, nine staging rows and 21 real
workers in Chromium `150.0.7871.186`; visual/performance/ecology acceptance
and ordinary-new-world activation remain separate, pending gates.
Evidence:
`/opt/cursor/artifacts/mineslop_v7_clean_r4_handoff_3ca15922-c9f2-44ae-a47b-54274718ce76/successful_browser.tap`
(SHA-256 `19033b2e94c9692e5f58b333ec488c1fc2df0a1ec2b51d8767c7a078807a42af`).

Entry: `test/terrain-v7-worker.browser.integration.mjs`.
Build config: `test/terrain-v7-browser.vite.config.mjs`.
The fixture deliberately imports the actual `terrain.worker.js` through
`new Worker(new URL(...), {type:"module"})`, and creates unmodified production
Worlds with worker enabled and explicitly disabled. It does not inject a
generator factory or call `handleTerrainRequest` as a substitute for a Worker.

Work is fixed and sequential:

- Five cases: pillar0, pillar5, bowl0, shipwreck container owner(-19,-22),
  Nether-fortress container owner(-22,-24), all using `cedar-valley`.
- Each compares full blocks, biomes, effective states/fluids, sparse auxiliary
  planes, specs, and complete declarations/markers against cold native output.
  Opposite request orders and a repeated direct-worker request check warm-cache
  parity. Public `World.ensureArea` moves eight chunks away and back, proving
  normal World-cache eviction/reload and a changed resident incarnation.
- Real worker packets undergo an onward transferable-buffer round trip and
  detachment checks. Two adversarial delivery tests replay genuine worker
  payloads as synthetic `MessageEvent`s: stale epoch/unknown ID are ignored;
  wrong-version6 is rejected, then genuine v7 fallback supplies the chunk.
  The faulty worker is warmed first so the guard cannot pass on a worker that
  never started. Real direct-worker requests exercise7→6→unsupported8→7.
- Nine calls use Game's actual `stageWorld` entry point, native World,
  generation, landing and player-save validation. Fresh ordinary Overworld
  remains3; explicit7 has Overworld[-64,320). Saved End1–6 and7 override both
  requested Overworld and requested7 without migration. Every stage is low
  quality, exactly49 chunks:441 staged columns total. A native untouched chunk
  is compared in full; a stateful edit and saved pose survive staging,
  archive3 file export/import, and isolated-origin IndexedDB round trips.
- Fresh worlds intentionally generate nine synchronous spawn chunks, then
  queue exactly40 worker requests; saved poses generate zero synchronous
  chunks and queue49. The original zero-count fresh-world assertion was a
  test false positive, not observed worker fallback. The exact allowance is
  fixed, not measured dynamically; even one extra fallback chunk fails.
  Expanded4–7 counters are mandatory; legacy1–3 counters are unavailable,
  but exact request counts and empty pending/in-flight maps are still checked.
- There are21 actual Worker instances total, disposed sequentially; no shared
  browser/profile or application server is closed. The replay guards create at
  most three simultaneous workers. Diagnostics and network capture are capped
  at32 entries and fail on overflow.

This is native Game **staging**, not construction/rendering of `VoxelGame`.
No DOM, renderer or fabricated World stands in for native generation. The Node
fixture test uses the same production staging function with native Node
fallback and `fake-indexeddb`; its output explicitly says `browserGateRun:false`.
Source-cache eviction is also covered by the earlier v7 Node tests; this browser
gate specifically proves World-cache eviction and warm/order parity.

### Prepare a disposable frozen source and build (parent commands)

Do not copy fixtures into the immutable checkpoint or build the changing
development tree. Export the committed source and overlay only these test
files. The source SHA is pinned to shared-factory commit
`6ea12b135d8e30d8434b4f5156ab5bd08c417478`; v6 goldens are in the separate
`38ea7029f541595914b93d8a3aac699bfc97f987` checkpoint. Neither production
source nor any golden is rewritten.

```bash
DEV=/tmp/mineslop-development
SOURCE=/tmp/mineslop-v7-shared-checkpoint
SHA=6ea12b135d8e30d8434b4f5156ab5bd08c417478
test "$(git -C "$SOURCE" rev-parse HEAD)" = "$SHA"
CANDIDATE=$(mktemp -d /tmp/mineslop-v7-browser-src.XXXXXX)
OUT=$(mktemp -d /tmp/mineslop-v7-browser-build.XXXXXX)
git -C "$SOURCE" archive "$SHA" | tar -x -C "$CANDIDATE"
ln -s "$SOURCE/node_modules" "$CANDIDATE/node_modules"
for file in \
  terrain-v7-browser-host.js terrain-v7-browser-contract.js \
  terrain-v7-browser-staging.js terrain-v7-browser-fixture.js \
  terrain-v7-staging-generation.js terrain-v7-staging-generation.test.js \
  terrain-v7-browser.vite.config.mjs terrain-v7-worker.html \
  terrain-v7-worker.browser.integration.mjs terrain-v7-browser-fixture.test.js
do
  cp "$DEV/test/$file" "$CANDIDATE/test/$file"
done
export VITE_NATIVE_V7_SOURCE_SHA="$SHA"
export VITE_BENCHMARK_LABEL="v7-native-${OUT##*/}"
export VOXELCRAFT_NATIVE_V7_OUT_DIR="$OUT"
(cd "$CANDIDATE" && NODE_ENV=production mise exec node@22.22.0 -- node node_modules/vite/bin/vite.js build \
  --config test/terrain-v7-browser.vite.config.mjs)
chmod -R a-w "$OUT"
```

Prerequisites: the checkpoint's installed dependencies (Vite, Playwright,
fake-indexeddb), supported Node, and Playwright Chromium or an executable
`CHROME_BIN`. The output directory must be empty and absolute. The fixture
rejects missing/mismatched source SHA or label, HMR, raw source entries,
redirects, off-origin requests and nonnumeric/shared origins.

### Serve and run (parent commands; leave the frozen server running)

Use a fresh numeric-loopback port.6550 is an example; fail if already listening,
then choose another unused port instead of stopping an existing service.

```bash
PORT=6550
if ss -H -ltn "sport = :$PORT" | rg -q .; then
  echo "Choose an unused dedicated test port" >&2
  exit 1
fi
tmux -f /exec-daemon/tmux.portal.conf ls
SESSION="mineslop-v7-browser-${PORT}"
tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESSION" \
  -c "$CANDIDATE" -- python3 -m http.server "$PORT" \
  --bind 127.0.0.1 --directory "$OUT"
export VOXELCRAFT_TEST_URL="http://127.0.0.1:${PORT}/"
export VOXELCRAFT_NATIVE_V7_BUILD_LABEL="$VITE_BENCHMARK_LABEL"
RESULT_LOG=/opt/cursor/artifacts/mineslop_v7_real_browser_gate.tap
(cd "$CANDIDATE" && mise exec node@22.22.0 -- node --test --test-concurrency=1 \
  test/terrain-v7-worker.browser.integration.mjs) > "$RESULT_LOG" 2>&1
```

Use a new `RESULT_LOG` name for each run. Inspect its TAP result and JSON
diagnostic: source/build label, actual source URL, HTML SHA-256, compiled script
and worker URLs, Chromium version, all five comparisons, both replay guards and
all nine staging results. This gate requires one fresh headless browser and no
GPU/rendered scene. It sets `performanceCertification:false` and
`visualCertification:false`; LOD body/cap/Y256 support and the separate
visual/performance/ecology gates remain required before default activation.

Preservation validation on2026-09-04 in `/tmp/mineslop-development`:
9/9 focused Node tests pass under Node22.22.0, including all441 native staging
columns, saved1–6 preservation, explicit expanded7 staging, fixture cells,
comparison/prerequisite guards, syntax and five spawn-generation regression
tests. Evidence:
`/opt/cursor/artifacts/mineslop_v7_preservation_20260904_1336_node.tap`.
All ten browser fixture/helper/test files match the successful clean r4
overlay byte-for-byte, including all three handoff postimage hashes.
The overlay's tracked production source and existing test prerequisites match
the pinned commit; debug-instrumentation scans pass in both actual development
and clean overlay `src/test`. Identity evidence:
`/opt/cursor/artifacts/mineslop_v7_preservation_20260904_1336_identity.log`.
No further browser run is needed for these exact tested postimages.
