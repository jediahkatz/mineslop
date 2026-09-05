# Mineslop development roadmap

This is the working checklist for the next gameplay and world improvements.
An item is complete only when it works in the running game, survives saving and
loading, and has relevant regression tests and real browser verification.

## Current requested improvements

- [ ] **Farther, better-looking views.** Improve distant terrain and forest
  silhouettes, increase useful viewing range within measured CPU/GPU and memory
  budgets, and avoid gaps or abrupt transitions during chunk streaming. Distant
  LOD surfaces must retain blocky, stepped silhouettes rather than smooth hills.
  The user's badlands/End screenshots reopen visual acceptance: preserve narrow
  landforms instead of enlarging them into featureless coarse blocks, retain
  material/color character, and blend the near/far boundary with fog.
  The screenshot-driven material correction now shares the native block atlas,
  biome tint ratios and face shading, with owner-specific surface/soil/rock
  layers instead of gray risers. Local native v3/v7 Overworld and End GPU
  captures and v7 badlands pass; the material-only GPU gate checks twelve exact
  native/LOD pixel comparisons plus context restoration and texture ownership.
  This does not close geometry, vegetation, transition or performance acceptance.
  Preset detail radii remain 2/3/4. A diagnostic-only radius-six override now
  coordinates daylight/block-light fields and cache bounds, with GPU-cap checks.
  Bounded section/material pages restore complete native v7 detail ownership:
  radius four covers 81 columns at 431 submissions; radius six covers 169 at
  871, within the unchanged 128 MiB geometry and 1,024-submission limits.
  Radius six is not a performance recommendation: the measured scene retains
  another 128.7 MB of CPU source buffers and submits about 35% more camera-frustum
  triangles than section-sized meshes. Streaming and normal-lighting readiness
  remain acceptance gates. The frozen pre-atlas radius-four baseline completes
  detail, surface lighting and LOD, but still has 47 block-light pages unavailable
  at its strict 300-second deadline; no stationary FPS comparison is accepted.
  Radius eight exceeds travel's validated apron, and dense expanded-world light
  atlases are too large to treat eight–twelve chunks as a settings-only change.
- [ ] **Distant End landmarks.** Keep actual native obsidian pillars and their
  caps visible beyond detailed chunks. Ground-height LOD alone omits these
  features. Preserve edits and avoid duplicate proxies during partial detail
  transitions; do not invent terrain or force-load distant chunks.
- [ ] **More interesting worlds.** Richer landforms, coherent scenery and
  decoration, varied oceans, and discoverable structures with useful rewards.
  Compare the central End island's depressions, elevations and silhouettes with
  the supplied Minecraft reference. Separate generation improvements from LOD
  omissions, and keep saved generator outputs immutable.
- [ ] **Biome size and rarity.** Audit multiple seeds and large regions; common
  biomes should form substantial coherent areas, rare biomes should actually be
  uncommon, and neighboring climates should make sense. Reproduce unnatural
  boundary seams and cliffs before changing versioned generation.
- [ ] **Square sun.** Make the visible sun unmistakably square without breaking
  the day/night cycle, lighting, underground views or inspection settings.
- [ ] **Better lighting.** Improve daylight, dusk/night and local-light
  readability while preserving cave darkness, material identity and performance.
- [ ] **Torch brightness and persistent illumination.** Reproduce dim torch
  lighting and loss of ambient light as the viewer moves away. Visible receiver
  surfaces should not lose illumination solely because a light leaves a
  viewer-centered selection budget. Verify falloff, occlusion, multiple lights
  and bounded rendering cost separately from overall cave brightness.
- [ ] **Gradual tunnel lighting.** The complete native cave walk now keeps
  entrance surfaces lit through deep look-backs and retains faint detail in
  darkness. Verified locally with 15 GUI views, Fullbright off, no terrain
  edits, and GPU return/torch/context-recovery checks. See
  [cave lighting verification](cave-lighting.md) for scope and remaining
  inherited test/performance limits. The deployed fix still has a reported
  white-looking interior when viewed from the top of an entrance and potentially
  excessive cave brightness; neither was established by the controlled sample.
  Observer-dependent creature lighting is fixed and verified separately in
  [mob lighting](mob-lighting.md). Keep the remaining appearance reports open
  without reintroducing blackouts or merely darkening the whole scene. The user
  now suspects visible unloaded space: test partial loading, queued meshing,
  culling and sky/LOD leakage separately. The preloaded lighting comparison
  does not establish streaming coverage.
- [ ] **World-anchored clouds and weather.** Clouds must drift independently of
  player movement. Add rain/weather with bounded rendering/audio, appropriate
  biome/dimension/roof behavior, and coherent time, pause and save semantics.
- [ ] **Sand and gravel gravity.** Unsupported blocks must actually fall and
  settle, without item duplication, unloaded-world reads or unbounded cascades.
- [ ] **Every block gets a Minecraft-reference art review.** Compare each block
  directly with the actual vanilla Java block, then bring our original textures
  and models closer in pattern, palette, proportions, faces and lighting.
  Record the reference/version and check real placed, held and inventory views.
  Use adversarial checks for concrete deviations; blind naming is not the main
  test. Earlier recognizability passes do not establish Minecraft fidelity.
- [ ] **Ore and mining-block distribution.** Validate ore abundance, vein sizes
  and depth curves across generated chunks and seeds, including deep stone and
  dimension/biome-specific resources. Keep mineral progression sensible and
  version changes rather than altering existing saved terrain.
- [ ] **Horses and saddles.** Natural encounters and finite saddle acquisition,
  taming/saddling, mounting, steering, jumping and safe dismounting. Preserve
  horses, equipment and rider ownership through saves and lifecycle transitions.
- [ ] **Better footsteps and action sounds.** Replace harsh repetitive walking
  noise with softer material-specific variation; improve other action sounds
  without excessive volume, repeated buffer allocation or unbounded voices.
  Cover water entry/splashes, different walked surfaces and real menu clicks.
- [ ] **Original ambient music.** Compose sparse, mellow ambient pieces with
  original melodies and recordings; respect mute, pause and audio resource
  budgets rather than copying Minecraft music.
- [ ] **Animal noises.** Distinct original species voices with sensible timing,
  distance attenuation, mute behavior and limits on overlapping calls.
- [ ] **Animal behavior.** More believable idle, grazing, roaming, following and
  fleeing behavior, with sensible habitats and collision/path safety. Horses
  must not run autonomous movement while the player is controlling them.
- [ ] **Calibrated mob spawning.** Measure and tune passive/hostile density,
  species weights, biome/time/light/habitat gates, group sizes, population caps,
  spawn distances and replenishment. Avoid nearby pop-in, overcrowding and
  save/reload or pause/resume spawn bursts.
- [ ] **World difficulty.** Add saved Peaceful/Easy/Normal/Hard rules, with
  legacy saves defaulting to Normal. Keep passive-animal populations governed
  by habitats and separate caps; difficulty controls hostile danger and the
  Peaceful rules, not an indiscriminate multiplier on all spawning. Changes
  must not grant loot/XP or lose owned creatures and equipment.
- [ ] **Responsive mob combat and friendly fire.** Make attack timing, hitboxes,
  hurt/knockback and feedback satisfying. Stray projectiles and explosions can
  hit other mobs, with appropriate retaliation or fleeing against the actual
  attacker. Respect walls, closest hits, difficulty and owned-entity safety;
  keep kill/loot/XP attribution single and correct. The
  [pure combat foundations](combat-foundations.md) pass their checks but are
  not wired into gameplay; live friendly fire remains unchecked.
- [ ] **Enderman encounter behavior.** Verify eye-contact aggression, freezing
  under a player's gaze, pursuit when looking away and purposeful teleports,
  alongside fair melee timing, collision and actual damage feedback.
- [x] **Steadier first-person hands.** Smooth walking, mining and held-use
  transitions, including eating, bows and shields. Keep physical aiming,
  cooldowns and inventory transactions unchanged. Verified locally with 13
  trusted-input browser gestures; see [hand-motion verification](hand-motion.md)
  for evidence and scope. Deployment is separate from local verification.
- [ ] **Reliable water exits.** Fix jumping out of water and climbing ordinary
  shores while respecting ledge/headroom collisions and unloaded boundaries.
- [ ] **Swimming animation and underwater visibility.** Add readable swimming
  poses without destabilizing held-item actions or physical aim, and calibrate
  underwater visibility while preserving depth, lighting and cave readability.
- [ ] **Better boat controls.** Diagnose and improve steering, acceleration and
  camera/rider behavior, preserving Minecraft-style input, safe dismounting,
  collision and save/pearl/travel ownership.
- [ ] **XP and levels.** A complete earn/collect/progress/level-up loop with clear
  feedback and meaningful level spending through usable progression stations.
  Loading a save or spending levels must not trigger a false level-up.

## Existing expansion scope remains required

- [ ] Richer/deeper oceans, varied seabeds, kelp and reefs.
- [ ] Boats and fishing with real Survival acquisition, rewards and persistence.
- [ ] Shipwrecks, ocean ruins, monuments and treasure with persistent useful loot.
- [ ] Dolphins, turtles, drowned and guardians with appropriate live behavior.
- [ ] Bounded source/flowing water, currents, waterlogging and bubble columns.
- [ ] Usable wood families, stairs, slabs, doors, trapdoors, fences and ladders.
- [ ] Beds with sleep and safe respawn.
- [ ] Enchanting, brewing, anvils, villager trading and full armor progression.
- [ ] Throwable teleporting ender pearls, including interactions with vehicles,
  death, travel and save/reload.
- [ ] Expanded vertical worlds and discoverable structures integrated into
  normal new-world creation, not only test fixtures or catalogs.

Some of these systems already have implementations and focused tests. Their
unchecked status means their complete gameplay integration or final acceptance
verification is still pending, not that no code exists.

## Verified development checkpoints — September 4, 2026

These checkpoints are on the development branch, not a claim that GitHub Pages
has deployed them or that the full expansion checklist is complete.

- [Explicit expanded-world creation](https://github.com/jediahkatz/mineslop/commit/68cc6a2)
  now exposes experimental generation 7 through the real New World form.
  Classic remains the default; imported saves retain their recorded version.
  Atomic replacement tests cover activation failure, transaction abort,
  cross-tab ownership and closing a real browser tab during activation.
  A clean GUI walkthrough on the later
  [scheduler checkpoint](https://github.com/jediahkatz/mineslop/commit/e2c34b1feebc8574d0cb5db1a1f1a2cfbe5ab53f)
  confirms new expanded Survival creation, movement, mining, saving and reload
  with the seed, edited terrain and collected dirt retained. This does not yet
  establish the full enchanting, ocean or structure-acquisition route.
- [Live armor consumers](https://github.com/jediahkatz/mineslop/commit/abffe5a90a48306b6c5a97c2a78a7248167c638f)
  apply toughness, protection, armor wear and source-specific rules to actual
  damage paths, including fall and pearl damage. The
  [oversized-hit correction](https://github.com/jediahkatz/mineslop/commit/677e7b4dacf2e3fc31f3b6a269670eeb3484a0bf)
  preserves ordinary RNG behavior while bounding large armor/shield wear.
  Sixty focused regressions pass; full equipped-combat GUI acceptance remains.
- [Respiration and Depth Strider](https://github.com/jediahkatz/mineslop/commit/8efe574)
  now drive the live air clock and horizontal swimming. Saved fractional ticks,
  effect expiry, stale observations and idle transaction avoidance are tested.
  [Renewable carrots and wart](https://github.com/jediahkatz/mineslop/commit/ce0e045894f07abbda78ee233c9abc74fc5047df)
  have finite planting, growth and harvesting, with a paid new-farmer carrot
  offer. Historical farmer catalogs and legacy crop records remain loadable.
  The combined consumer/migration suite passes 146 checks. Native acquisition
  and GUI growth/swimming comparisons remain unverified.
- The bounded section scheduler passes 35 focused tests. Separate wall-material,
  End-landmark/fog and visibility-priority work still needs combined rendered
  acceptance. A successful isolated pillar handoff is not a frame-rate claim.
- Barrels, blast furnaces and conduits still need complete live behavior and
  acceptance; catalog entries and recipes do not satisfy that requirement.

GUI testing exposed root-backed Chrome allocation failures on a nearly full VM
disk. Routing the test browser's temporary files, cache and crash storage into a
bounded tmpfs allowed the unchanged build to load and complete the GUI flow.
The exact native fatal stack remains unknown. Software-rendered, contended-VM
timings do not establish hardware-GPU performance or a 60 FPS guarantee.

## Invariants and verification

- Preserve every existing save and device preference. Do not silently regenerate
  a world or change an already-saved generator's output; version generation
  changes and migrate owned data losslessly.
- Retain Minecraft Java-style desktop controls and coherent voxel-style UI.
- Use original game artwork, models and sound design.
- Keep resource, entity and equipment transactions atomic: no duplicated
  saddles, mounts, loot, XP, station contents or projectiles.
- Keep simulation, rendering and audio work bounded. Compare real frame times
  and resource counts under matched scenes/settings, and distinguish software
  rendering measurements from hardware GPU performance.
- Cover changes with unit/integration tests and real browser Survival,
  resource-accounting, save/reload and visual/audio checks as appropriate.
- Keep the currently deployed site stable while development happens on an
  isolated feature branch. Finish and verify coherent changes before release.
- Deploy verified batches regularly; unfinished independent work must not hold
  every improvement until the entire roadmap is complete. Keep unverified
  changes out of each release.
