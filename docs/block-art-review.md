# Mineslop block art review

## Status and scope

The catalog contains 270 block IDs: 105 historical IDs and 165 expansion IDs.
All 270 have rendered through the real browser harness. The 19 ore IDs have
completed a source-specific paired visual review after refinement, including
controlled native-32px comparisons; see the [ore review checkpoint](ore-art-review.md).
Their final manifest status is **blocked**, pending final combined-source
evidence and live-world checks. The other 251 IDs remain **unreviewed**.
No final approval is claimed by runtime coverage or an intermediate review.

The denominator is always the live `BLOCK_CATALOG`, never an ID interval,
`BLOCKS.length`, a handpicked gallery, or the number of unique shared textures.
Oak/birch/etc. construction parts each need their own decision even when they
deliberately share plank pixels. Missing/new IDs, duplicate IDs and mismatched
symbols fail the manifest check. A screenshot is evidence of rendering only,
not an approval. This file is the authoritative per-block status manifest;
`test/block-art-review/reviews.json` stores individual supporting decisions.

Air is intentionally invisible. Water/lava are special fluid cells; portal cells
use their actual current geometry. They remain in the denominator and receive
explicit reviews. The harness does not invent obtainable items, modeled portals,
growth stages, furnace-lit states, or shapes that the registry does not support.

## Per-block adversarial rubric

Both critics must address every criterion for every ID, using specific evidence:

- `identity`: Guess the material without its label first. Name the nearest
  confusable catalog ID and the visual cue that separates them. Reject identity
  carried only by text, hue, memorized catalog position or a numeric ID.
  For Air, judge deliberate absence versus an accidentally invisible material.
- `faces`: Inspect top, side and bottom, every authored texture part, opposite
  views, tiling seams, and axis/facing states. End grain must follow the axis;
  door halves and bed halves must join. Flag flipped/stretching UVs or a front
  design copied onto every face where that undermines the object.
- `pixelArt`: Judge original pixel clusters, material structure, edges, value
  hierarchy, scale and repetition. Reject generic seeded noise or noisy recolors
  that technically differ in bytes but do not communicate different materials.
  Intentional shared family material is acceptable; it does not waive shape QA.
- `lighting`: Check the canonical state in daylight, real cast shadow and night.
  Does it retain material structure, useful contrast, and clear silhouette without
  Fullbright? Brightness should not erase texture or make normal matter glow.
- `alphaEmission`: Check silhouette holes against light/dark backgrounds,
  cutout thresholds, glass/water blending, opaque faces, haloing, and which pixels
  remain luminous at night. Glow berries must not make the whole sprig full-bright.
  State explicitly when opacity/non-emission is the intended behavior.
- `inventoryHeld`: Inspect the actual 64px and 32px inventory icons and the actual
  production held view. Recognize the same object at small size; flag false cube
  silhouettes, broken multipart icons, missing parts and inappropriate alpha.
  Do not substitute a nicer review-only icon/model for the product's output.
- `states`: Inspect every declared representative case for that ID. Doors/beds
  must have valid companion cells, ladders real support, stairs real corner
  neighbors, fences real connection neighbors, and waterlogged blocks actual
  host fluid. Flag misleading shape, face alignment or disconnected parts.

Suggested comparisons: stone/cobblestone/gravel/deepslate; coal and cinnabar ores
versus host rock; iron/gold/copper ores across hosts; glass/ice/packed ice/blue ice;
snow/snow block/wool/quartz; mud/podzol/mycelium; bark and plank families;
each wood family's slab/stair/fence/gate; coral family and live/dead versions;
chest/barrel/composter; furnace/blast furnace; smithing/cartography/crafting tables;
anvil/chipped/damaged; glowstone/sea lantern/magma/potent sulfur; kelp/seagrass/fern.
These are review prompts, not findings or approvals.

Record `needs-work` for visible defects and `blocked` for missing evidence.
No family-level, sheet-level, inherited, automated or blanket visual approvals.
One strong complaint is enough to withhold approval until it is fixed and
re-rendered. A critic may conclude a current block already looks good, but must
still provide its own comparison and all seven specific judgments.

## Browser harness contract

Entry: `/test/block-art-review/index.html`, served by its own Vite config.
This is a clearly labeled **authored production-component QA fixture**, not
natural gameplay or a performance benchmark.

Production paths used, without mock assets:

- `blockTexturePixels()`, `tileFor()`, `createAtlas()` and all real dispatchers.
- `buildChunkGeometry()` through the resolved-cell mesher, including AO, UVs,
  cutouts, multipart shapes and separate fluid volumes.
- `createChunkMaterials()` and `Atmosphere` lights, normal tone mapping, fixed
  time, and no Fullbright. The stage is neutral/untinted to isolate authored art.
- `blockIcon()` at 64px/32px and `createHeldItemView()` / `selectHeldItem()` /
  `updateHeldItemView()` without changing the production held model.

Each card contains two real GPU renders (upper/north/east and lower/south/west),
every top/side/bottom texture part at integer 6× scale, both inventory sizes and
an unscaled crop of the real 480×270 first-person held view. Do not downsample
the contact sheets for review. The six-card plate is 1472px wide, three columns
by at most two rows. View at 100%; crop an individual card for close criticism
without throwing away the complete sheet and its receipt.

Bounds: one WebGL context; one shared atlas/material set; one case resident at
a time; at most six cards per page; at most 16 cases per block; at most 32 authored
cells per case in one 16³ section. Shadow staging adds 25 actual stone cells
with main-pass color/depth writes disabled, so they cast a shadow without hiding
the subject. A tighter shadow frustum is fixture staging, not a production
shadow-quality claim. The held shadow preset uses ambient-only light, not a
cast hand shadow. Resources are disposed between cases/pages; no world generation,
workers, saves, local storage or endless animation loop are started.

Limitations requiring a later real-game check: biome tint, environment context,
local point-light spill, animated water, full gameplay HUD/hand overlap, placement,
growth/utility behavior and natural generation. These plates cannot approve
those behaviors. Current stations that render as cubes stay cubes here; report
that fact to the geometry owner rather than inventing a harness-only model.

URL options:

- `set=catalog|states`: canonical case of every selected ID, or all remaining
  representative cases. An empty/out-of-range states page rejects.
- `group=all|<group>`: groups come from `window.__mineslopBlockArtReview.groups()`.
  Wood families have separate groups; earth/masonry, foliage, marine, ores,
  stations, glass/light and special cells cover the remainder.
- `ids=3,8,52`: up to six distinct live IDs for adversarial comparisons, mutually
  exclusive with a named group. Never assume a comparison sheet is full coverage.
- `page=0`: zero-based, six cases maximum; rejects invalid/out-of-range pages.
- `light=day|shadow|night`; `labels=labeled|blind`.
- `seed=mineslop-block-art-v1`: fixed seeded permutation, identical across label
  modes. Blind plates omit ID/name/state/group labels and show only Sample A–F.
  The URL and receipt contain the answer key: give critics the PNG only.

API: `window.__mineslopBlockArtReview` exposes `ready`, `busy`, `error`, `kind`,
`version`, async `render(options)`, `snapshot()`, `groups()` and `dispose()`.
Wait for `ready || error`, assert no error, then read `snapshot()`. A snapshot
includes the live catalog count, build fingerprint, exact cells/states/fluids,
face/part list, atlas tiles, resolved link/attachment information, GPU receipts,
sample-token answer key, preset and explicit limitations. Concurrent renders
reject. Nothing in the API changes review status.

The dedicated build writes to `dist-art-review/`, separate from the deployable
game's `dist/`. It records the complete source fingerprint and commit SHA.
Any production JS/CSS, harness code or package change invalidates prior evidence
conservatively. Review prose/decisions do not invalidate themselves. A running
dev build is not a frozen evidence source: prefer build+preview and rebuild after
any source edit. The capture runner refuses a stale build or mid-capture edits.

## Evidence matrix and workflow

For **every** ID, require:

1. Canonical state, labeled, day + shadow + night.
2. Canonical state, blind, day; independent identity guess before label reveal.
3. Every remaining case from `casesFor(id)`, labeled, day.

This is representative valid-state coverage, not the Cartesian product of every
state with every environment. Cases include three log axes, four facings, top/
bottom/double slabs, inner/outer and inverted stairs, linked door halves with
open/closed and both hinges, paired beds, supported ladders, connected fences,
gates/trapdoors, waterlogging, fluid levels and submerged aquatic hosts.
Unknown shape kinds fail until a profile is explicitly added.

Use `queue.mjs` to enumerate the whole deterministic matrix, or one group at a
time. Do not let six readable samples become a claim that the other 264 passed.
The coordinator keeps an outstanding-ID list and the receipt-to-sample answer
key. Keep each critic batch to one six-card sheet; for multipart/state reviews
use `ids=<one-ID>` and page through states.

Capture blind sheets first. Give an independent critic only those PNGs, not
the manifest, answer-key JSON, source names or labeled plates. Preserve its
initial guess, comparison and timestamp. Then reveal identity and let it finish
the rubric; a second independent adversarial critic attacks the labeled
faces/states/lighting/presentation. Critics must disagree with an apparent
approval when evidence warrants it. Each ID keeps separate judgments.

After initial rendered criticism, the art owner may change textures/painters.
Coordinate geometry/renderer/gameplay defects with their owners. Commit/push
the coherent change before its verification loop. Rebuild, re-capture affected
plates, and obtain fresh judgments. Because fingerprints are conservative,
final completion requires evidence matching the final combined source checkpoint.

## Post-checkpoint parent commands

Run from the repository root after checkpointing the source, using installed
dependencies. Package tasks and matching root/leaf mise tasks are registered.

```sh
npm run test:block-art-review
npm run check:block-art-review
node test/block-art-review/queue.mjs --group wood-oak
npm run build:block-art-review
```

Start preview in a descriptive tmux session (reuse one if present):

```sh
tmux -f /exec-daemon/tmux.portal.conf ls
SESSION_NAME="mineslop-block-art-preview"
tmux -f /exec-daemon/tmux.portal.conf has-session -t "=$SESSION_NAME" 2>/dev/null || tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESSION_NAME" -c "$PWD" -- "${SHELL:-bash}" -l
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESSION_NAME:0.0" 'npm run preview:block-art-review' C-m
```

If that tmux config is unavailable, omit `-f /exec-daemon/tmux.portal.conf`.
Keep the preview running for parent/manual review. Capture/test commands use it:

```sh
npm run test:block-art-review:browser
node test/block-art-review/capture.mjs --group ores --labels blind --light day --page 0 --output /opt/cursor/artifacts/mineslop_ores_blind_day_01
node test/block-art-review/capture.mjs --group ores --labels labeled --light day --page 0 --output /opt/cursor/artifacts/mineslop_ores_labeled_day_01
node test/block-art-review/capture.mjs --group ores --labels labeled --light shadow --page 0 --output /opt/cursor/artifacts/mineslop_ores_shadow_01
node test/block-art-review/capture.mjs --group ores --labels labeled --light night --page 0 --output /opt/cursor/artifacts/mineslop_ores_night_01
node test/block-art-review/capture.mjs --ids 1028 --set states --labels labeled --light day --page 0 --output /opt/cursor/artifacts/mineslop_oak_door_states_01
```

Each output directory must be new. `MINESLOP_BLOCK_ART_URL` (or `--url`) overrides
`http://127.0.0.1:5176`; `CHROME_BIN` selects an existing Chrome binary. The runner
captures exactly one bounded sheet, rejects browser/GPU errors and invalid links,
then writes `sheet.png` and `capture.json` with the PNG SHA-256. It never installs
dependencies, starts a server or approves artwork. Its own disposable headless
browser closes; the preview is left running.

For the requested real GUI walkthrough the parent uses computer-use plus a short
screen recording after boot/validation. Call it an authored block-art fixture.
Deliver a small representative evidence set with links/receipts for the complete
review archive; do not flood the final answer with hundreds of redundant sheets.

## Decision schema and completion gate

For each reviewed ID add a unique record to `reviews.json` with:

- `id`, a unique `key`, current `sourceFingerprint`, `captures` (absolute
  `capture.json` paths), and `openFindings` (empty only when resolved).
- `critics`: at least two distinct `reviewer` identifiers, one `role: "blind"`
  and one `role: "adversarial"`; each has `reviewedAt`, `nearestConfusableId`,
  a specific `comparison`, and all seven `criteria`.
- Each criterion has `verdict: "pass"` only after genuine review, a substantive
  `note`, and an `evidence` array referencing that record's capture paths.
- The blind critic additionally has `blindCapture`, preserved `initialGuess`,
  and `labelsRevealedAt`. Its initial `reviewedAt` must precede label reveal
  and follow the capture. Do not rewrite a mistaken initial guess.

Set that exact ID's manifest status to `approved` and fourth field to its
record `key` only when both critics pass all criteria, required captures exist,
and no findings remain. Other permitted statuses are `unreviewed`, `needs-work`
and `blocked`. The `-` field means no decision record, never a waiver.

```sh
node test/block-art-review/verify.mjs
node test/block-art-review/verify.mjs --require-complete
```

The first checks manifest/claimed approvals and prints counts/outstanding IDs;
unreviewed rows are valid checkpoint data. The second must fail until all live
IDs have separate, current, evidence-backed approvals. The verifier checks
actual PNG files/hashes, all required case/light/label combinations, all face
parts and surfaces, successful GPU receipts, source freshness, individual
criteria, independent critic identities and blind/reveal ordering. Missing
artifact files after moving machines are blockers, not grounds to skip the gate.

This is a fail-closed accounting system, not an aesthetic oracle or proof of
critic honesty. Hashes and nonempty prose cannot replace reading the images.
Never label a passing pixel/coverage test “all blocks visually approved.”

## Per-block status manifest

Machine-readable rows: numeric ID, exact registry symbol, status, decision key.
Do not collapse ranges, remove invisible/special IDs, auto-add approved entries,
or copy a family's approval to its constituent blocks.

<!-- mineslop-block-art-manifest:start -->
```text
0 AIR unreviewed -
1 GRASS unreviewed -
2 DIRT unreviewed -
3 STONE unreviewed -
4 SAND unreviewed -
5 OAK_LOG unreviewed -
6 LEAVES unreviewed -
7 PLANKS unreviewed -
8 COBBLESTONE unreviewed -
9 GLASS unreviewed -
10 BRICK unreviewed -
11 WATER unreviewed -
12 SNOW unreviewed -
13 BEDROCK unreviewed -
14 COAL_ORE blocked -
15 BIRCH_LOG unreviewed -
16 BIRCH_LEAVES unreviewed -
17 GLOWSTONE unreviewed -
18 RED_FLOWER unreviewed -
19 YELLOW_FLOWER unreviewed -
20 SPRUCE_LOG unreviewed -
21 SPRUCE_LEAVES unreviewed -
22 ACACIA_LOG unreviewed -
23 ACACIA_LEAVES unreviewed -
24 JUNGLE_LOG unreviewed -
25 JUNGLE_LEAVES unreviewed -
26 CHERRY_LOG unreviewed -
27 CHERRY_LEAVES unreviewed -
28 DARK_OAK_LOG unreviewed -
29 DARK_OAK_LEAVES unreviewed -
30 PALE_LOG unreviewed -
31 PALE_LEAVES unreviewed -
32 CACTUS unreviewed -
33 DEAD_BUSH unreviewed -
34 TALL_GRASS unreviewed -
35 PODZOL unreviewed -
36 MUD unreviewed -
37 MYCELIUM unreviewed -
38 RED_MUSHROOM unreviewed -
39 BROWN_MUSHROOM unreviewed -
40 MUSHROOM_STEM unreviewed -
41 TERRACOTTA unreviewed -
42 RED_TERRACOTTA unreviewed -
43 ORANGE_TERRACOTTA unreviewed -
44 YELLOW_TERRACOTTA unreviewed -
45 WHITE_TERRACOTTA unreviewed -
46 RED_SAND unreviewed -
47 SANDSTONE unreviewed -
48 ICE unreviewed -
49 PACKED_ICE unreviewed -
50 BLUE_ICE unreviewed -
51 SNOW_BLOCK unreviewed -
52 GRAVEL unreviewed -
53 CLAY unreviewed -
54 MOSS unreviewed -
55 DRIPSTONE unreviewed -
56 SCULK unreviewed -
57 BAMBOO unreviewed -
58 MANGROVE_LOG unreviewed -
59 MANGROVE_LEAVES unreviewed -
60 CORAL unreviewed -
61 SEAGRASS unreviewed -
62 IRON_ORE blocked -
63 GOLD_ORE blocked -
64 DIAMOND_ORE blocked -
65 COPPER_ORE blocked -
66 REDSTONE_ORE blocked -
67 EMERALD_ORE blocked -
68 LAPIS_ORE blocked -
69 OBSIDIAN unreviewed -
70 NETHERRACK unreviewed -
71 SOUL_SAND unreviewed -
72 BASALT unreviewed -
73 BLACKSTONE unreviewed -
74 CRIMSON_STEM unreviewed -
75 CRIMSON_LEAVES unreviewed -
76 WARPED_STEM unreviewed -
77 WARPED_LEAVES unreviewed -
78 END_STONE unreviewed -
79 PURPUR unreviewed -
80 CHORUS unreviewed -
81 LAVA unreviewed -
82 TORCH unreviewed -
83 CRAFTING_TABLE unreviewed -
84 FURNACE unreviewed -
85 CHEST unreviewed -
86 WOOL unreviewed -
87 TNT unreviewed -
88 FARMLAND unreviewed -
89 WHEAT_CROP unreviewed -
90 MELON unreviewed -
91 PUMPKIN unreviewed -
92 NETHER_PORTAL unreviewed -
93 END_PORTAL unreviewed -
94 SUGAR_CANE unreviewed -
95 FERN unreviewed -
96 LILY_PAD unreviewed -
97 SUNFLOWER unreviewed -
98 PINK_PETALS unreviewed -
99 SULFUR unreviewed -
100 CINNABAR unreviewed -
101 POTENT_SULFUR unreviewed -
102 SULFUR_SPIKE unreviewed -
103 CAVE_VINE unreviewed -
104 GLOW_BERRIES unreviewed -
1024 COPPER_BLOCK unreviewed -
1025 BOOKSHELF unreviewed -
1026 OAK_SLAB unreviewed -
1027 OAK_STAIRS unreviewed -
1028 OAK_DOOR unreviewed -
1029 OAK_TRAPDOOR unreviewed -
1030 OAK_FENCE unreviewed -
1031 OAK_FENCE_GATE unreviewed -
1032 LADDER unreviewed -
1033 WHITE_BED unreviewed -
1034 MAGMA_BLOCK unreviewed -
1035 KELP unreviewed -
1036 DEEPSLATE unreviewed -
1037 SEA_LANTERN unreviewed -
1038 COBBLED_DEEPSLATE unreviewed -
1040 TUBE_CORAL_BLOCK unreviewed -
1041 TUBE_CORAL unreviewed -
1042 TUBE_CORAL_FAN unreviewed -
1043 BRAIN_CORAL_BLOCK unreviewed -
1044 BRAIN_CORAL unreviewed -
1045 BRAIN_CORAL_FAN unreviewed -
1046 BUBBLE_CORAL_BLOCK unreviewed -
1047 BUBBLE_CORAL unreviewed -
1048 BUBBLE_CORAL_FAN unreviewed -
1049 FIRE_CORAL_BLOCK unreviewed -
1050 FIRE_CORAL unreviewed -
1051 FIRE_CORAL_FAN unreviewed -
1052 HORN_CORAL_BLOCK unreviewed -
1053 HORN_CORAL unreviewed -
1054 HORN_CORAL_FAN unreviewed -
1060 DEEPSLATE_COAL_ORE blocked -
1061 DEEPSLATE_IRON_ORE blocked -
1062 DEEPSLATE_COPPER_ORE blocked -
1063 DEEPSLATE_GOLD_ORE blocked -
1064 DEEPSLATE_REDSTONE_ORE blocked -
1065 DEEPSLATE_DIAMOND_ORE blocked -
1066 DEEPSLATE_LAPIS_ORE blocked -
1067 DEEPSLATE_EMERALD_ORE blocked -
1068 NETHER_GOLD_ORE blocked -
1069 NETHER_QUARTZ_ORE blocked -
1070 ANCIENT_DEBRIS blocked -
1071 QUARTZ_BLOCK unreviewed -
1072 DEAD_TUBE_CORAL_BLOCK unreviewed -
1073 DEAD_TUBE_CORAL unreviewed -
1074 DEAD_TUBE_CORAL_FAN unreviewed -
1075 DEAD_BRAIN_CORAL_BLOCK unreviewed -
1076 DEAD_BRAIN_CORAL unreviewed -
1077 DEAD_BRAIN_CORAL_FAN unreviewed -
1078 DEAD_BUBBLE_CORAL_BLOCK unreviewed -
1079 DEAD_BUBBLE_CORAL unreviewed -
1080 DEAD_BUBBLE_CORAL_FAN unreviewed -
1081 DEAD_FIRE_CORAL_BLOCK unreviewed -
1082 DEAD_FIRE_CORAL unreviewed -
1083 DEAD_FIRE_CORAL_FAN unreviewed -
1084 DEAD_HORN_CORAL_BLOCK unreviewed -
1085 DEAD_HORN_CORAL unreviewed -
1086 DEAD_HORN_CORAL_FAN unreviewed -
1087 PRISMARINE unreviewed -
1088 PRISMARINE_BRICKS unreviewed -
1089 DARK_PRISMARINE unreviewed -
1090 SPONGE unreviewed -
1091 WET_SPONGE unreviewed -
1092 GOLD_BLOCK unreviewed -
1093 MOSSY_COBBLESTONE unreviewed -
1094 NETHER_BRICKS unreviewed -
1095 NETHER_BRICK_STAIRS unreviewed -
1096 NETHER_BRICK_SLAB unreviewed -
1097 NETHER_BRICK_FENCE unreviewed -
1098 NETHER_WART_CROP unreviewed -
1099 SPAWNER unreviewed -
1100 COMPOSTER unreviewed -
1101 LECTERN unreviewed -
1102 CARTOGRAPHY_TABLE unreviewed -
1103 SMITHING_TABLE unreviewed -
1104 BIRCH_PLANKS unreviewed -
1105 BIRCH_SLAB unreviewed -
1106 BIRCH_STAIRS unreviewed -
1107 BIRCH_DOOR unreviewed -
1108 BIRCH_TRAPDOOR unreviewed -
1109 BIRCH_FENCE unreviewed -
1110 BIRCH_FENCE_GATE unreviewed -
1111 SPRUCE_PLANKS unreviewed -
1112 SPRUCE_SLAB unreviewed -
1113 SPRUCE_STAIRS unreviewed -
1114 SPRUCE_DOOR unreviewed -
1115 SPRUCE_TRAPDOOR unreviewed -
1116 SPRUCE_FENCE unreviewed -
1117 SPRUCE_FENCE_GATE unreviewed -
1118 ACACIA_PLANKS unreviewed -
1119 ACACIA_SLAB unreviewed -
1120 ACACIA_STAIRS unreviewed -
1121 ACACIA_DOOR unreviewed -
1122 ACACIA_TRAPDOOR unreviewed -
1123 ACACIA_FENCE unreviewed -
1124 ACACIA_FENCE_GATE unreviewed -
1125 JUNGLE_PLANKS unreviewed -
1126 JUNGLE_SLAB unreviewed -
1127 JUNGLE_STAIRS unreviewed -
1128 JUNGLE_DOOR unreviewed -
1129 JUNGLE_TRAPDOOR unreviewed -
1130 JUNGLE_FENCE unreviewed -
1131 JUNGLE_FENCE_GATE unreviewed -
1132 CHERRY_PLANKS unreviewed -
1133 CHERRY_SLAB unreviewed -
1134 CHERRY_STAIRS unreviewed -
1135 CHERRY_DOOR unreviewed -
1136 CHERRY_TRAPDOOR unreviewed -
1137 CHERRY_FENCE unreviewed -
1138 CHERRY_FENCE_GATE unreviewed -
1139 DARK_OAK_PLANKS unreviewed -
1140 DARK_OAK_SLAB unreviewed -
1141 DARK_OAK_STAIRS unreviewed -
1142 DARK_OAK_DOOR unreviewed -
1143 DARK_OAK_TRAPDOOR unreviewed -
1144 DARK_OAK_FENCE unreviewed -
1145 DARK_OAK_FENCE_GATE unreviewed -
1146 PALE_OAK_PLANKS unreviewed -
1147 PALE_OAK_SLAB unreviewed -
1148 PALE_OAK_STAIRS unreviewed -
1149 PALE_OAK_DOOR unreviewed -
1150 PALE_OAK_TRAPDOOR unreviewed -
1151 PALE_OAK_FENCE unreviewed -
1152 PALE_OAK_FENCE_GATE unreviewed -
1153 MANGROVE_PLANKS unreviewed -
1154 MANGROVE_SLAB unreviewed -
1155 MANGROVE_STAIRS unreviewed -
1156 MANGROVE_DOOR unreviewed -
1157 MANGROVE_TRAPDOOR unreviewed -
1158 MANGROVE_FENCE unreviewed -
1159 MANGROVE_FENCE_GATE unreviewed -
1160 CRIMSON_PLANKS unreviewed -
1161 CRIMSON_SLAB unreviewed -
1162 CRIMSON_STAIRS unreviewed -
1163 CRIMSON_DOOR unreviewed -
1164 CRIMSON_TRAPDOOR unreviewed -
1165 CRIMSON_FENCE unreviewed -
1166 CRIMSON_FENCE_GATE unreviewed -
1167 WARPED_PLANKS unreviewed -
1168 WARPED_SLAB unreviewed -
1169 WARPED_STAIRS unreviewed -
1170 WARPED_DOOR unreviewed -
1171 WARPED_TRAPDOOR unreviewed -
1172 WARPED_FENCE unreviewed -
1173 WARPED_FENCE_GATE unreviewed -
1174 BAMBOO_PLANKS unreviewed -
1175 BAMBOO_SLAB unreviewed -
1176 BAMBOO_STAIRS unreviewed -
1177 BAMBOO_DOOR unreviewed -
1178 BAMBOO_TRAPDOOR unreviewed -
1179 BAMBOO_FENCE unreviewed -
1180 BAMBOO_FENCE_GATE unreviewed -
1181 BAMBOO_BLOCK unreviewed -
1182 BARREL unreviewed -
1183 BLAST_FURNACE unreviewed -
1184 BREWING_STAND unreviewed -
1185 ENCHANTING_TABLE unreviewed -
1186 ANVIL unreviewed -
1187 CHIPPED_ANVIL unreviewed -
1188 DAMAGED_ANVIL unreviewed -
1189 IRON_BLOCK unreviewed -
1190 SMOOTH_STONE unreviewed -
1191 CONDUIT unreviewed -
1192 TURTLE_EGG unreviewed -
1193 CARROT_CROP unreviewed -
1194 DRIED_KELP_BLOCK unreviewed -
```
<!-- mineslop-block-art-manifest:end -->
