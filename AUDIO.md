# Original procedural audio

`Effects` owns one lazy `AudioEngine` and its `SoundBank`. `AudioEffects` from
`src/audio.js` is an alias of that same engine, not a second mixer. The existing
material/action DSP, soft-sponges/boat mapping, pearl throw, eating, hit,
teleport and level-up cues remain in use.

All sounds are synthesized locally: no recordings, downloads, added
dependencies, ambient loops, persistent oscillators or audio timers. Existing
two-argument calls still work.

## Event contract

```js
effects.sound("step", supportingBlockId);
effects.sound("mine", brokenBlockId);
effects.sound("place", placedBlockId);
effects.sound("shoot", itemId);
effects.sound("block", shieldId);
effects.sound("hit");
effects.sound("eat");
effects.sound("teleport");
effects.sound("xp", collectedAmount);
effects.sound("levelup", newLevel);
effects.sound("horse-step", supportingBlockId, { position: horsePosition });
effects.sound("animal", species, { position: animalPosition });
```

Every call returns a boolean: `true` means admitted to playback; `false` means
muted, locked/suspended, disposed, inaudible, unknown, cooling down or voice-full.
It does not promise audibility at the OS/device. Refused calls are never queued.
Audio does not change entity state, decide spawning, move animals or award XP.

Animal IDs: `horse`, `cow`, `sheep`, `pig`, `chicken`, `wolf`, `goat` and
`mooshroom` (the cow voice/cooldown). The original vocal gestures are a
rising/fluttering whinny, rounded moo, tremulous bleat, nasal double grunt,
falling clucks, short breathy howl and higher bleat. Other IDs, including
fish/squid, are silent. Three small pitch/noise variants preserve each identity.

`break` remains an alias for mining, including wooden boat break events.
`shoot` with an ender-pearl item keeps its softer throw cue. `fishing-splash`,
`fishing-bite` and `fishing-catch` are water/collection action cues, not fish
vocalizations.

## Position and attenuation

The optional third argument accepts:

- `position: { x, y, z }`: world-space source in blocks. `Effects` uses the
  camera's current world position and right vector, including third-person view.
- `distance`: finite non-negative block distance, overriding calculated distance.
- `pan`: finite `-1` (left) through `+1` (right), overriding calculated pan;
  out-of-range values clamp.
- `volume`: a `0..1` multiplier; it cannot increase the designed gain.
- `maxDistance`: audible radius, default `24` blocks (`18` for horse steps),
  clamped to `3..32`. Calls cannot be amplified across an entire biome.

For a separately chosen physical listener, supply `distance` and `pan` instead:

```js
effects.sound("animal", "cow", { distance: 9, pan: -0.4, volume: 0.8 });
```

Omitting position and distance means a local, centered cue. World animal/horse
integrations must supply position or distance. Bad coordinates/non-finite
controls are rejected before sample/node allocation. The behavior owner filters
cross-dimension, unloaded and inactive entities; the mixer does not read world
state.

Gain is full through two blocks, then
`((maxDistance - distance) / (maxDistance - 2)) ** 2`, clamped to `0..1`.
It is zero at/outside the radius; multipliers at or below `0.001` are dropped.
Computed pan is normalized source direction dotted with camera right.
Position is sampled once per short call, not tracked every frame. There is no
occlusion or HRTF; browsers without stereo panning retain distance attenuation.

## Behavior scheduling and quiet-world policy

The behavior owner schedules calls. Use per-animal randomized simulation-time
cooldowns around `12..30` seconds, with a randomized first delay. Emit only from
living, active, loaded, nearby animals. Advance the behavior cooldown after each
attempt regardless of the returned boolean. Do not emit every update, retry a
refusal next frame or replay missed calls after pause/travel/load.

Independent mixer safety guards:

- At least `1.1` audio-clock seconds between accepted animal calls.
- Species minimums: cow/mooshroom `7s`, sheep/goat `6s`, pig/chicken `5s`,
  horse `8s`, wolf `10s`. These are aggregate guards, not behavior schedules.
- At most two animal voices and twelve voices total. Two total slots remain
  reserved for level-up/teleport cues; ordinary/animal events can occupy at most
  ten. Existing per-group movement, impact and XP ceilings also remain active.
- Refusal allocates no nodes or samples, and never cuts an existing audible tail.

## Parent hooks: XP and hoof contact

XP: compare the committed level before/after an actual XP award. On an increase,
emit one `sound("levelup", newLevel)` for that award; otherwise emit
`sound("xp", collectedAmount)`. Do not emit both, emit during HUD refreshes, or
emit when loading a save/switching modes. Crossing several levels still gets one
short original bloom; the level does not add cache keys. Threshold detection and
XP ownership remain with the parent integration.

Horse: emit `sound("horse-step", supportingBlockId, { position })` only for a
committed grounded stride/contact. Accumulate traveled distance in the behavior
or mount owner, not held movement input. Reset on teleport, spawn, mount changes
and loss of ground; do not catch up contacts missed during a pause.
One event already contains a compact two-hoof clop. Keep events at least `0.11s`
apart, suppress player walking sounds while seated, and emit no hooves while
idle, airborne or swimming.

Material families cover stone, wood, metal, glass, grass, dirt, sand, gravel,
snow, cloth and water. Expanded woods/stations use metadata. Basalt remains
stone despite log-shaped artwork; terracotta does not become sand. Mining and
placement share cached impact PCM but retain distinct playback rates/gains.

## Lifecycle and cost bounds

Call `effects.unlockAudio()` only from an existing trusted play/unmute gesture.
It returns a readiness promise and absorbs construction/resume failures.
Concurrent unlocks share one pending resume. `sound()` never opens/resumes a
context or queues sounds while autoplay is blocked.

`effects.soundEnabled = false` fades the master over `15ms` and stops active
sources within `18ms` of audio time. Suspended contexts release voices directly.
Rapid unmute clears old muted voices before raising gain, without replay.
`effects.dispose()` stops/disconnects every voice, clears the bank and closes
the context, including during a pending resume. A disposed mixer never reopens.

Samples are mono 24 kHz Float32, at most 1.5 seconds. Material/action samples keep
their tapered original DSP and 0.65 peak ceiling; animal samples add vocal-tract
resonances, DC removal, attack/release and a 0.68 peak ceiling. Every live voice
also receives a short output envelope. The voice gain cap and shared master
leave headroom even with twelve aligned voices.

Each event uses one buffer source, one gain and at most one stereo panner. The
LRU holds at most 48 buffers and 2 MiB. In-flight sources may retain at most
twelve additional samples after cache eviction. A miss temporarily holds one
extra synthesis array/buffer. Keys never include entity IDs, world coordinates,
arbitrary levels or XP amounts.

`effects.audioDiagnostics()` reports readiness, voice/cache counts and limits.
The existing explicit bank API remains available: `SoundBank.next(definition)`
selects a non-repeating variant; `SoundBank.get(definition, variant)` and
`AudioEngine.bufferFor(definition, variant)` access that same canonical LRU.
`AudioEngine.buffers`, `cachedBytes` and `bank` expose bounded cache state.
Normal integrations use `Effects.sound()`, not direct cache warming per frame.

The five final audio modules are `src/audio.js`, `src/audio-dsp.js`,
`src/audio-samples.js`, `src/audio-spatial.js` and `src/animal-audio.js`. They
reuse the standalone `audio-engine.js`, `sound-bank.js`, `material-sounds.js`
and `sound-synthesis.js`; there is only one playback/caching path.

## Verification

Run only after the parent delivery checkpoint. From this standalone repository
root, the full suite is `npm test` or `mise run test`. Focused coverage is:

```sh
node --test test/audio-samples.test.js test/audio.test.js test/effects.test.js
```

The focused tests cover material routing, retained action cues, deterministic
animal gestures, envelopes, cache entry/byte bounds, spatial controls, reserved
voices, mute/autoplay/disposal and the `Effects` facade. The existing effects
tests guard geometry and held-item behavior. Listening to real playback remains
necessary to judge perceived animal identity; numerical tests are not listening
evidence.
