# Mineslop development roadmap

This is the working checklist for the next gameplay and world improvements.
An item is complete only when it works in the running game, survives saving and
loading, and has relevant regression tests and real browser verification.

## Current requested improvements

- [ ] **Farther, better-looking views.** Improve distant terrain and forest
  silhouettes, increase useful viewing range within measured CPU/GPU and memory
  budgets, and avoid gaps or abrupt transitions during chunk streaming.
- [ ] **More interesting worlds.** Richer landforms, coherent scenery and
  decoration, varied oceans, and discoverable structures with useful rewards.
- [ ] **Biome size and rarity.** Audit multiple seeds and large regions; common
  biomes should form substantial coherent areas, rare biomes should actually be
  uncommon, and neighboring climates should make sense.
- [ ] **Square sun.** Make the visible sun unmistakably square without breaking
  the day/night cycle, lighting, underground views or inspection settings.
- [ ] **Better lighting.** Improve daylight, dusk/night and local-light
  readability while preserving cave darkness, material identity and performance.
- [ ] **Gradual tunnel lighting.** Remove the sudden whole-view blackout when
  entering a tunnel. Check light falloff near the entrance, views back toward
  daylight, torch-lit interiors and transitions in both directions.
- [ ] **Every block gets an adversarial art review.** Render the entire block
  catalog with real game textures and geometry, record a verdict for each block,
  and fix weak/confusable materials, bad face seams, transparency, lighting and
  held/inventory presentation. Re-review changes rather than relying on labels
  or a handful of attractive examples.
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
- [ ] **Steadier first-person hands.** Smooth walking, mining and held-use
  transitions, including eating, bows and shields. Keep physical aiming,
  cooldowns and inventory transactions unchanged.
- [ ] **Reliable water exits.** Fix jumping out of water and climbing ordinary
  shores while respecting ledge/headroom collisions and unloaded boundaries.
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
