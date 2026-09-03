# Explicit v5 generation checkpoint

This is an implementation checkpoint, **not activation or a verified v5 release**.
`GENERATOR_VERSION` remains **3**. Only `createGenerator(seed, dimension, 5)`
selects v5. No saved world version is rewritten.

Work is confined to `/tmp/mineslop-development` on
`cursor/mineslop-distance-horses-audio-351d`. No commits, staging, pushes,
dependency installation, server startup, or new-code test execution were
performed by the generation worker. The parent owns the cumulative checkpoint
and subsequent validation.

## Completed baseline evidence

The read-only deployed checkout `/tmp/voxelcraft-standalone` reported commit
`afe5fdcc000dd5bd28ee94a514627741db0da247` and an empty working-tree status.
The only executed generation diagnostic imported that checkout's factory and
default-fluid function, not the development implementation.

`test/terrain-v4-golden.json` pins 47 chunks and nine spawn results across
`cedar-valley`, `mineslop-audit-2`, and the empty seed, in Overworld, Nether and
End. Coordinates include origin, negative chunks, spawn chunks, distant chunks,
world borders, and actual shipwreck/ocean-ruin sites. Hashes cover:

- Block IDs in explicit little-endian u16 encoding.
- Biome IDs.
- Effective full-height state planes, including implicit zeroes.
- Effective full-height fluid planes, including implicit fluid defaults.
- Complete structure declarations and sparse section representation.
- Actual spawn coordinates.

The fixture's canonical SHA-256 is
`6b6f16551afa69e5be72bfb133745961370302e60766236e29b17c4e91b6b67a`.
That value is a literal in the test, not derived from a generator under test.
The deployed generator also repeated every captured chunk with warmed caches.
The baseline log is `docs/terrain-v4-golden-capture.log` (`capture_exit=0`).
Existing v1-v3 hash constants in `test/terrain-hash.test.js` are untouched.

The capture utility is a manual baseline tool, excluded from the test command.
Do not regenerate the fixture from development code to make a regression pass.

## Generation changes

- Ordinary biome owners use a 384-block jittered/warped field. Broad temperature
  and moisture retain separate 1710/1070-block inputs. Common biomes use
  explicit weights; rare variants require the appropriate parent biome,
  climate/elevation conditions and a coherent inset within a successful owner.
- Hills and peaks follow uplift and actual height. All existing biome IDs
  remain in the registry; real spatial-coverage tests check ordinary, rare,
  cave and other-dimension variety.
- Mushroom destinations use a separate 1536-block candidate lattice,
  occurrence roll, ocean eligibility and 210–330-block radius. Rarity no longer
  comes from shrinking an extreme noise tail into a tiny island.
- Each mineral has a separate deterministic occurrence channel, depth curve,
  connected cardinal deposit shape, size range and air rule. Copper has both
  occurrence and size enrichment in dripstone cave fields.
- Emerald/debris deposits contain 1–3 cells, biased toward small finds.
  Their inset owners prevent separate rare deposits from joining into giant
  groups. A per-horizontal-owner Y phase avoids global ore-free Y planes.
  Common deposits can cross owner/chunk boundaries and merge; the tests measure
  surviving connected groups rather than assuming attempted size equals vein
  size.
- Ordinary stone transitions to deepslate at Y=8..0; stone is absent below zero
  in the natural mineral host. Badlands preserve a terracotta cap and colored
  layers with real stone interbeds, so high gold can actually replace a host.
- High rock receives overlapping upper iron and coal distributions. Exposed
  mountain stone is eligible. Nether netherrack/blackstone deposits apply to
  floors, ceilings and detached shelves, not just the lower floor fill.
- Exposure decisions query the exact pre-ore natural columns used to fill the
  world: caves, aquifers, cave skins, Nether shelves and ceiling all participate.
  Only cardinal `AIR` triggers air-discard rules; water/lava do not.
  These queries never generate decorated chunks or recursively query ores.
- End has no ore pass.
- Existing v4 writer, cave geometry/skins, trees, marine features and structure
  layouts are reused without modifying their generation functions or tables.
  V5 has its own frozen all-eight-family manifest and declaration adapter.
  Structures retain layout-v1 IDs but declarations carry generator version 5.

These are original Minecraft-like tuning choices, not copied game code/assets,
Minecraft seed parity, or claims of universal vanilla ore percentages. Factual
relationships are described by the public
[ore overview](https://minecraft.wiki/w/Ore),
[deepslate generation](https://minecraft.wiki/w/Deepslate),
[copper ore](https://minecraft.wiki/w/Copper_Ore),
[emerald ore](https://minecraft.wiki/w/Emerald_Ore) and
[ancient debris](https://minecraft.wiki/w/Ancient_Debris) references.

## Shared compatibility changes

Every shared production-file change is listed here:

- `src/terrain.js`: add imports and an explicit v5 dispatch branch; the v4 and
  v1-v3 bodies and `GENERATOR_VERSION = 3` remain unchanged.
- `src/world-spec.js`: accept explicit v5 with the same expanded bounds as v4;
  preserve historical bottom-layer edit restrictions for v1-v3.
- `src/chunk-data.js`: require explicit expanded vertical bounds for v5 packets,
  as already required for v4. Existing schema, copying, type and identity checks
  remain in force.
- `src/terrain-v4-transport.js`: this shared validator selects the v5 frozen
  manifest only for a v5 job. All prior jobs retain the v4 manifest checks.
  It still rejects cross-generator declarations and malformed anchor cells.
- `src/canonical-structure-identity.js`: layout-v1 canonical identities accept
  generator 4 or 5 and return the supplied version. Seed, dimension, family,
  owner-coordinate grammar and all legacy opaque-ID checks stay unchanged.
- `src/item-stack-data.js`: map-target version validation accepts 5; world
  identity, canonical owner membership and position checks are unchanged.
- `src/pearl-save.js`: detached projectile version validation accepts 5; other
  identity/lifetime/position checks are unchanged.
- `src/fuses.js`: the existing expanded-world bottom-layer rule also applies to
  v5; older versions retain the same restriction.

The new dependency-free `src/generator-version.js` accepts exactly 1–5 and
recognizes exactly 4/5 as expanded. Unknown future versions still fail closed.
Other context/save validators already delegate to `getWorldSpec` and require no
generation-worker changes.

Three old negative fixtures now use unsupported version **6** rather than
newly supported version 5: `test/terrain-v4-foundation.test.js`,
`test/native-v4-world.integration.test.js`, and
`test/settlement-context.test.js`. Their positive v1-v4 cases and goldens are
unchanged.

## Parent-owned integration still required

Do not activate v5 until these runtime gates are handled and exercised:

- `src/game.js`: the staged-world exploration-install gate is strict `=== 4`.
- `src/save-preflight.js`: native exploration/identity preflight gates are
  strict `=== 4`.
- `src/exploration-host-state.js`: `nativeExplorationContext` rejects worlds
  and generator objects whose version is not 4.
- `src/exploration-admission.js`: manifest, world and declaration gates require
  4. Canonical re-description also calls the historical `describeStructure`,
  which deliberately still returns v4 declarations. Select
  `describeV5Structure` from `src/terrain-v5-manifest.js` for v5, preserving the
  real bare sampler and version-match checks.
- `src/exploration-materialization.js` and
  `src/game-exploration-services.js`: native chest-materialization gates reject
  versions other than 4.
- `src/settlement.js`: `_matchesWorld` accepts only `[1, 2, 3, 4]`.
- `src/settlement-state.js`: `settlementPositionValid` treats only version 4 as
  expanded when validating bottom-layer stations/crops.

These files were not edited by the generation worker. Re-scan at the cumulative
checkpoint because other workers/parent changes can introduce or remove gates.
The v4 factory's own strict dispatch and frozen manifest are intentional and
must not be indiscriminately changed to v5.

The parent also owns `game-world-stage.js`, `game-archive.js`, new-world
selection, UI/settings, ecology/progression/horse integrations, and browser
validation. Keep restored worlds on their saved version; only newly created
worlds should adopt a subsequently approved default.

## Bounded work and memory

These are structural bounds, not measured performance claims:

- Regions have integer width/depth in 1–64. Full-height Overworld block storage
  is at most 3 MiB per region or 192 KiB per aligned chunk, plus biome,
  declaration and sparse auxiliary buffers.
- Natural occupancy retains at most 4608 u16 columns: at most 3.375 MiB of
  typed-array payload in Overworld, or 2.25 MiB in Nether/End. A cold 16x16 chunk
  needs at most 18x18 natural columns; a cold maximum region's cardinal halo is
  66x66. Exposure cannot expand outside that halo.
- Column/ordinary-owner/mushroom/cave/deposit/tree/marine/locator caches are
  capped at 8192/1024/128/2048/4096/1024/512/64 entries respectively.
  Cross-dimension lookup retains at most two additional generators.
- Ore owner spacing is 8; spill is at most 3 cells per axis, or 1 for tiny rare
  deposits. At most eight Overworld mineral passes, four horizontal owner cells
  per axis per chunk, and 51 vertical owners per mineral. A maximum region has
  at most ten horizontal owners per axis.
- A successful descriptor has at most 24 points. Shape growth admits at most
  six frontier neighbors per selected point. Each candidate uses at most six
  natural-air reads. No generation path scans the surrounding world.
- Native structures retain the v4 owner/descriptor/sample/write limits:
  eight decorators, at most eight descriptors and 256 column samples per
  decorator/owner, at most 65536 attempted writes per decorator/owner.
  Native layout-v1 uses 192-block owners with zero spill between owners.
- Spawn probes retain the bounded 193x193 search, at most 96 real candidate
  validations, and small actual terrain/path checks. Biome locators retain the
  bounded 129x129 cheap scan and at most 64 real validations. Failed searches
  return failure/null rather than fabricated safe terrain.
- `getNaturalBlock` is an explicit rasterizing diagnostic; HUD/LOD consumers
  should continue to use `sampleColumn`, `surfaceYAt` and `getBiome`.

## Parent verification commands

New-code tests and audits below have been **written but not executed**. Run them
only after the requested parent checkpoint, with working directory explicitly
`/tmp/mineslop-development`, in a task-specific tmux session. No dependency
installation or server is needed for these Node gates.

First freeze older output and check dispatch/transport/save contracts:

```sh
node --test /tmp/mineslop-development/test/terrain-hash.test.js /tmp/mineslop-development/test/terrain-v4-golden.test.js /tmp/mineslop-development/test/terrain-v4-foundation.test.js /tmp/mineslop-development/test/terrain-v4-seams.integration.test.js /tmp/mineslop-development/test/terrain-v5-generation.test.js /tmp/mineslop-development/test/terrain-v5-transport.integration.test.js /tmp/mineslop-development/test/terrain-v5-save.integration.test.js
```

Then measure the biome/resource acceptance gates:

```sh
node --test /tmp/mineslop-development/test/terrain-v5-biomes.test.js /tmp/mineslop-development/test/terrain-v5-ores.integration.test.js
```

Reproducible paired audits, with coordinate-fixed and targeted samples kept
separate (each includes both versions and all six fixed audit seeds):

```sh
node /tmp/mineslop-development/test/terrain-v5-audit.mjs baseline 4,5 > /tmp/mineslop-development/docs/terrain-v5-baseline.jsonl
node /tmp/mineslop-development/test/terrain-v5-audit.mjs targets 4,5 > /tmp/mineslop-development/docs/terrain-v5-targets.jsonl
node /tmp/mineslop-development/test/terrain-v5-audit.mjs biomes 4,5 > /tmp/mineslop-development/docs/terrain-v5-biomes.jsonl
```

Use `mise run test` for the cumulative existing suite after parent integration.
The usual parent formatting/build/browser gates still apply. Existing tests
that intentionally assert a default of 3 should only change with the separate,
fully verified activation.

## Remaining fidelity and verification gaps

There are no measured v5 density/vein/scale results yet. The added acceptance
thresholds describe desired relationships and must be checked against actual
output; do not tune away a failure without inspecting its metrics.

Large special iron/copper mega-veins, true three-dimensional density/overhang
terrain, and exact Minecraft seed/generation parity are not implemented.
Existing cave geometry and decorators remain original v4 building blocks.
Rare-owner spacing and interbedded badlands are explicit bounded approximations.
Distribution, locator success across seeds, all native structures, throughput,
and natural resource-acquisition playability still need the parent runs.

After calibration is accepted, pin v5 goldens before default activation. Once
v5 saves are in use, further output-changing tuning requires another version.

## Exact generation-worker file set

Modified:

- `src/terrain.js`
- `src/world-spec.js`
- `src/chunk-data.js`
- `src/terrain-v4-transport.js`
- `src/canonical-structure-identity.js`
- `src/item-stack-data.js`
- `src/pearl-save.js`
- `src/fuses.js`
- `test/terrain-v4-foundation.test.js`
- `test/native-v4-world.integration.test.js`
- `test/settlement-context.test.js`

Added:

- `src/generator-version.js`
- `src/terrain-v5.js`
- `src/terrain-v5-biomes.js`
- `src/terrain-v5-config.js`
- `src/terrain-v5-field.js`
- `src/terrain-v5-manifest.js`
- `src/terrain-v5-natural.js`
- `src/terrain-v5-navigation.js`
- `src/terrain-v5-ores.js`
- `test/terrain-golden-digest.js`
- `test/terrain-v4-golden-capture.mjs`
- `test/terrain-v4-golden.json`
- `test/terrain-v4-golden.test.js`
- `test/terrain-v5-audit-helpers.js`
- `test/terrain-v5-audit.mjs`
- `test/terrain-v5-biome-audit.js`
- `test/terrain-v5-biomes.test.js`
- `test/terrain-v5-generation.test.js`
- `test/terrain-v5-native-fixtures.js`
- `test/terrain-v5-ores.integration.test.js`
- `test/terrain-v5-save.integration.test.js`
- `test/terrain-v5-transport.integration.test.js`
- `docs/terrain-v4-golden-capture.log`
- `docs/terrain-v5-checkpoint.md`

Other dirty/untracked files belong to the parent or other workers and are not
part of this generation checkpoint.
