# Animal behavior and natural spawning

This contract applies to the standalone checkout at `/tmp/mineslop-development`.
The helpers and `mob-ai.js`/`mob-navigation.js` are implemented here. The parent
owns `wildlife.js`, Game/settings/UI/save wiring, live horse ownership, and audio.
No replacement entity owner, inventory transaction or saved archive is introduced.

## Behavior context

Supply these read-only/observation hooks in `wildlife.context`:

- `ownsMotionThisFrame(mob)`: true for EVERY horse whose pose is owned by riding
  this frame, including untamed/bareback rides and a horse dismounted earlier in
  the same frame. Retain that claim across every Wildlife substep; release only
  after the frame ends. `stepMob()` checks it before gravity, knockback, turning,
  hopping, relocation and generic movement flags. Tamed/saddled flags do not
  grant motion authority. Its voice clock still advances.
- `retainsMob(mob)`: true when a real owner requires retaining the identity
  (horse/saddle owner, companion owner, persistent encounter). On unsupported
  loaded ground, AI does not relocate or cull a retained mob. Retention does not
  grant motion authority, following behavior, taming, or teleport permission.
- `isAnimalTempted(mob)`: optional read-only check of the actual held item.
  Returning true suggests following only while the physical player is visible,
  vertically nearby and within 14 blocks. It never consumes food or creates a
  feeding/taming/breeding transaction. Existing committed `followTime` also works.
- `onAnimalEvent(mob, event)`: optional observation after the next voice cooldown
  is already committed. The exact audio adapter is:

```js
onAnimalEvent: (mob) => effects.sound("animal", mob.kind, {
  position: { x: mob.position.x, y: mob.position.y, z: mob.position.z },
})
```

Ambient and alarm attempts share randomized 12–30 second cooldowns, including
the first call after restore. Mute, no observer, distance and audio admission
refusal never refund a due opportunity. The AI does not inspect audio state,
retry refused voices, allocate audio, or generate a different species sound.
The initial audible gate is a physical 3D radius of 24; attenuation, voice
overlap and the final admission decision remain with audio.

The current audio registry voices horse, cow, sheep, pig, chicken, wolf, goat
and mooshroom (cow voice). Other behavior profiles remain silent through the
ordinary refused-call path. A due voice also rechecks loaded footprint metadata,
including on a frame-owned horse; the spent timer is never refunded.

The fourteen common land-animal profiles keep coherent idle/graze/roam/flee
intents with a home radius, night rest, follow hysteresis (start 3.2, stop 2.1),
and a shy-animal release radius of 7. `mob.animalIntent` and `mob.grazing` are
render-only pose hints, not resource changes. Herbivores never turn grass into
dirt or mint food/health from an animation. Tamed wolves retain their companion
follow/defend branch, with the same voice clock. Ordinary hostiles, Enderman
stare/chase/teleport, ranged attacks, and aquatic ecology do not use land-animal
steering.

Animal routes use swept full bodies, loaded footprint/support checks and hazard
avoidance. At most three lookahead directions of at most 1.6 blocks are probed;
successful detours persist for 0.9 seconds. Blocked routes wait 0.8/1.6/2.4
seconds instead of shuffling against a wall every substep. Turns precede
walking. Navigation clamps elapsed steps to 0.2 seconds and speed to 6.
All behavior/navigation/voice state is ephemeral; do not add it to `mob-save`.

### Parent lifetime guard is required

`Wildlife.update()` performs lifetime relocation/removal BEFORE `stepMob()`.
The AI guard alone cannot undo an earlier host teleport. The parent's current
horse bridge already delegates `context.ownsMotionThisFrame` to `horseServices`
and `context.retainsMob` to `retainsHorse`/ecology ownership. Keep that guard in
the host lifetime loop, retain/dormant owned horses outside loaded range, and
keep companion catch-up confined to the explicit tamed-WOLF branch.

The current parent loop also skips `stepMob()` entirely for frame-owned horses.
That is motion-safe, but skips their voice clock too. Calling `stepMob()` with
the supplied motion-authority predicate is safe and lets its voice-only path
run. Do not tick both that path and a second owner voice scheduler.

Do not mistake retention for taming: a retained hostile encounter is still
suspended by Peaceful, not made freely killable. The parent owns authoritative
preservation of sidecar equipment, tombstones and encounter completion.

## Spawn schedule, density and work bounds

Use `src/mob-spawn-policy.js` instead of the generic 1.5-second refill/36-attempt
loop. Create a clock once for an installed Wildlife owner:

```js
let spawnClock = createMobSpawnClock(`${world.seed}:${world.dimension}`);
```

Keep it across pause/resume and difficulty changes. The default
`{ restored: true }` waits a full maximum refill interval plus 0–1 second of
deterministic phase jitter: 10–11 seconds for land animals, 12–13 for swimmers,
3–4 for hostiles. Repeated save/reload cannot shorten a refill cooldown.
Pass `{ restored: false }` only for a genuinely brand-new world, never for
restore, dimension travel or a mode change.

- `passive`: cap 12 land animals; randomized 6–10 second opportunities.
  Brand-new-world warmup is 2–4 simulation seconds.
- `aquatic`: cap 4 peaceful swimmers; 8–12 second opportunities.
  Brand-new-world warmup is 3–5 seconds.
- `hostile`: cap 10 across hostile/watchful species, including ecology
  hostiles; 2–3 second opportunities and brand-new-world warmup.
- Total residency still uses `MAX_MOBS` (28) or the lower host `maxEntities`.
  Villagers consume total and species capacity, not an animal-density slot.
  Owned/dormant records in the bounded resident array still consume their slots.
- Each pulse proposes at most 8 columns; each group has at most 3 members.
  One shared frame allowance permits at most 4 successful admissions across
  natural and ecology hosts. Never reset that allowance per pulse or per group.
- `stepMobSpawnClock(previous, dt, { paused, difficulty })` returns
  `{ state, pulses }`. Install `state` even if every candidate is unloaded,
  blocked, occupied or over capacity. There is no catch-up loop or queued debt.
  A huge delta contributes at most 0.2 simulation seconds.

Peaceful consumes but does not emit hostile opportunities. The other two lanes,
their random streams and their site/species/group rolls are identical across
difficulties. Easy/Normal/Hard do not multiply populations or refill rates.

## Parent spawn admission sequence

1. Advance the clock ONCE in the outer active frame, not per AI substep.
2. For each pulse, call `sampleMobSpawnColumn(pulse, physicalPlayer, attempt)`
   for attempts 0–7. It returns `cellX`, `cellZ`, `x`, `z`, `speciesRoll` and
   `groupRoll`, never a guaranteed safe height or an entity ID.
3. Check loaded columns before reading them. Resolve a candidate height from
   already-admitted terrain/fluid data. Build the detached habitat observation
   below; do not invoke generators or use the distant visual terrain as support.
4. Read `countMobSpawnPopulation(wildlife.entities)`. Pass that count plus
   `{ difficulty, maxEntities, frameRemaining }` to
   `naturalMobSpawnCandidates(pulse.pool, site, population, options)`.
5. `chooseMobSpawnSpecies(candidates, column.speciesRoll)` returns a kind or
   null. Do not redirect a failed/Peaceful hostile opportunity into an animal.
6. `planMobSpawnGroup(kind, actualAnchor, column.groupRoll)` returns stable
   `{ slot, x, z, nearY }` proposals. `nearY` is ONLY a height hint. Resolve each
   member's actual y and reread its own habitat/light/loaded footprint. A group
   can cross a hill, shore, torch boundary or missing chunk.
7. For each member, recheck `remainingMobSpawnCapacity()` against CURRENT
   residents/frame allowance, recheck species eligibility, actual collision,
   natural support, world bounds and physical-player distance with
   `mobSpawnDistanceAllowed(actualPosition, physicalPlayer)`. Natural distance
   is 24–48 inclusive AFTER all jitter, altitude and group offsets.
   Keep existing inter-mob spacing, killed-site and identity reservation checks.
8. Only the real host commits/spawns and decrements `frameRemaining` on success.
   A refused candidate never creates an entity, advances an owned ID, clears a
   tombstone or counts as an encounter completion.

Keep the legacy root site ID for group slot 0
(`dimension:cellX,cellZ:p`, `:w` or `:h`); suffix other stable slots, for example
`:1` and `:2`. A cap/occupied slot must not cause the other slots to be renumbered.
Do not put a frame serial into persistent natural IDs or recreate killed sites
on every refill. Explicitly reserve identities with the existing host checks.

### Actual habitat/light observation

Provide `site` fields:
`loaded`, `dimension`, `biomeId`, `timeOfDay`, `underground`, `water`,
`groundId`, `blockLight`, `skyLight`, `waterDepth`.

`loaded` means the complete candidate footprint/body can be read now.
`blockLight` and `skyLight` are actual integer local light levels 0–15;
`skyLight` is adjusted for the actual day/night cycle. Missing required light
fails closed. Fullbright, the two renderer-selected point lights, visual fog,
and a hard-coded `blockLight: 0` are NOT authoritative spawn light.
The parent must supply a bounded loaded-cell/light reader; these helpers do
not fabricate a light engine from rendering settings.

Biome/dimension matching reuses `speciesForBiome`, including Nether/End
Enderman rules. Additional policy:

- Common pasture animals require daylight, local light at least 9 and
  grass/moss support. Existing animals are not removed at night.
- Foxes are nocturnal with no daylight minimum. Camels require sand/red sand;
  rabbits also admit sand and snow. Bears admit snow/ice; frogs admit wet soils;
  mooshrooms require mycelium. Each still requires its existing biome.
- Sulfur cubes stay harmless, underground and in sulfur caves on rocky/sulfur
  support. They do not inherit the pasture daylight requirement.
- Cod/squid require actual water and their own minimum water depth, at any time.
- Overworld hostiles require zero block light and effective sky light at most 7,
  plus night or an underground site. Nether/End keep their existing dimension
  and habitat semantics. Natural support rejects cactus, magma, logs and leaves.

`NATURAL_MOB_PROFILES` exports the complete relative weights, group sizes and
species caps. Sheep weight 12; pig/cow/chicken 10; horse/goat/frog 4; rabbit 6;
wolf/fox/bear 2; panda/camel 1. Common herds and horses use 2–3 members, small
specialists 1–2, and creepers/Endermen/ghasts are single arrivals. Existing
species caps are never enlarged. All weights apply only after habitat gates.

### Ecology and persistent actors

Native villagers, dolphins, turtles, drowned, guardians, elders and blazes are
deliberately excluded from generic weighted selection and group creation.
Keep their canonical marker, habitat, breeding and transaction owners.
The parent ecology admission bridge should:

- Gate natural attempts by the corresponding emitted pool
  (`mobPopulationPool(kind)`), rather than running all animals whenever a
  hostile pulse fires. NPC/unique marker checks keep their independent bounded
  cadence; they still consume the shared total/frame allowance.
- Use `remainingMobSpawnCapacity()` in the admission guard, including
  difficulty, and recheck it at commit; decrement the shared allowance only for
  a successful new admission. Keep ecology's own stricter species/marker caps.
- Do not apply new-spawn pulse or habitat filters to saved identities or a
  retained actor's lifecycle. Waking needs loaded space and bounded active
  capacity, not a new identity or a duplicate marker claim.

See `mob-difficulty.md` for Peaceful suppression, source attack/effect cleanup
and the single incoming-damage scaling boundary. Neither clock nor policy
removes creatures, awards drops/XP or completes persistent encounters.

## Checkpoint-gated verification

No tests, servers, installs or Git writes have been run for this delivery.
After the parent's complete-delivery checkpoint, run from this checkout:

```sh
node --test test/animal-behavior.test.js test/animal-navigation.test.js \
  test/mob-animal-behavior.integration.test.js test/mob-spawn-policy.test.js \
  test/mob-difficulty.test.js
node --test test/mob-ai.test.js test/mob-navigation.test.js \
  test/wildlife.test.js test/wildlife-safety.test.js test/mob-save.test.js
```

After parent integration, add live owner-bound checks for a bareback ride,
same-frame dismount, retained unloaded horse, audio refusal/mute, loaded-only
group admission, torch/cave boundaries, repeated pause/reload, and an incomplete
elder encounter across difficulty changes. The pure schedules and synthetic
fixtures are regression coverage, not a claim of measured live-game density.
