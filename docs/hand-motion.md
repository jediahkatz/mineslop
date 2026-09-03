# Held-item motion and verification

The two hand views retain independent, bounded presentation state in
`src/held-motion.js`. Time-based envelopes smooth selection, walking and held
food/bow/shield transitions. Selection changes the visible item immediately;
only its pose eases. Projection happens after blending, preserving screen
anchoring across FOV/aspect changes without moving the physical camera.

Accepted mining calls `requestHeldItemMining(this.effects)` before visual
update. Each request renews one visual-update lease; absence of another request
lets mining motion ease out. It no longer repeatedly writes a small `swing`
value that a slow frame can immediately erase. Existing one-shot swing writes
remain impulses. Mining duration/progress, damage, use timing and inventory
transactions are unchanged.

Local phases wrap and large deltas advance one capped visual step. Hidden
views discard transient motion. Reduced-motion preferences suppress decorative
bob/mining/equip motion while retaining meaningful use poses. State and geometry
are reused; no per-frame preference listeners or new gameplay clocks are added.

## Executed verification

- The focused motion/use/player suite passes 61 checks; the expanded
  Effects/motion/use/input suite passes 62 after initializing real motion state
  in its older Effects fixtures.
- `test/held.browser.integration.mjs` passes all 13 real-input gestures:
  sustained Survival mining and release, main/offhand shields, a paid food
  cycle, food cancellation, paid bow release, bow cancellation, walking,
  F1/F5, reduced motion and pause/resume.
- Browser assertions inspect actual completed Game/render frames, hand
  transforms, physical aim/body, unchanged owner/method identities and real
  resource accounting. All observed input events are trusted. No hand-probe
  instrumentation, replacement physics, fake frames or forced success values
  are used.
- Both manual shield windows complete release/cancel plus 350ms, with no
  overflow/errors, unchanged resources and 20HP. The reviewed video shows
  intermediate raising and a stable inactive hand/camera. Its low capture rate
  does not resolve every return frame; automated frame assertions verify
  release easing separately.

The browser fixture is explicitly authored, not a Survival-acquisition claim:
110 stone/obsidian cells are added only in existing loaded air, native terrain
is preserved, finite equipment is supplied and the four starter apples remain.
One initial hunger change from 20 to 12 enables food testing. Health, AI, damage,
world time and action timers are not overridden. Manual clips enable the game's
Fullbright inspection setting to see the otherwise unlit sealed room.

Manual mining windows are not used as complete acceptance evidence: desktop
mouse batching/round-trip durations could not reliably fit their observation
window. The automated trusted-input test verifies sustained mining, repeated
rendered strokes, unchanged mining timing and complete release.

All temporary production hand probes are removed. The obsolete temporary
capture script is archived outside the repository; the durable browser
fixture and test remain committed.

## Repeating the browser test

Build and serve a fresh frozen realtime host on an isolated numeric-loopback
port. The test does not start a server and refuses protected/shared origins.

```sh
VITE_BENCHMARK_LABEL=held-verification mise run build:realtime
npm run preview:realtime -- --host 127.0.0.1 --port 5662 --strictPort
```

Run in the matching frozen checkout:

```sh
VOXELCRAFT_TEST_URL=http://127.0.0.1:5662/ \
VOXELCRAFT_HELD_BUILD_LABEL=held-verification \
mise run test:held
```

Use the configured Node toolchain. On the current Cloud image,
`MISE_NODE_VERSION=22.14.0` selects it for nested tasks. The test writes a fresh
`/tmp/mineslop-held-browser-*/acceptance.json`, including source/served-build
hashes and failure evidence. A passed transform test is not a hardware-FPS or
world-lighting benchmark.
