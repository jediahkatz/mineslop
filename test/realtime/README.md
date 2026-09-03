# Real-time browser bot

This is an automated, continuous-input control/performance test, not a
model-paced GUI walkthrough. A Node loop holds movement keys, alternates
sprinting with Ctrl and strafing, sends native mouse yaw/pitch sweeps, and uses
terrain height observations to ascend/descend with Space/Shift after a real
double-Space Creative flight toggle. It never writes player
position or velocity during a measured segment.

The dedicated `index.html` loads the real styles and statically imports the
actual `VoxelGame` class. It uses the actual generated world, worker, renderer,
player physics, wildlife, UI, and IndexedDB archive. `window.__voxelBot` exists
only on this test page; no production globals or flags are required.

## Dependencies and execution

Required:
- The app's existing dependencies.
- `playwright` as a development dependency (install the latest release).
- An installed Chrome/Chromium executable. No Playwright browser download is
  needed. `CHROME_BIN` overrides filesystem discovery of common Linux paths.
- A frozen production benchmark host, built with `npm run build:realtime` and
  served with `npm run preview:realtime` on port 5175. Set
  `VOXELCRAFT_TEST_URL` to that server. The development server also supports
  this test entrypoint, but hot reload can invalidate a run while source changes.

From the repository root, after installing dependencies and starting
the benchmark host through the package/mise workflow:

```bash
VOXELCRAFT_TEST_URL=http://127.0.0.1:5175 node test/realtime/run.mjs \
  --duration 55 \
  --quality low \
  --width 1920 --height 1080 \
  --output /opt/cursor/artifacts/voxelcraft_realtime_low.json
```

Use a task-specific tmux session for the server and runner. Do not run alongside
manual GPU QA if you want comparable performance measurements.
On software-WebGL VMs, minimize other game windows too: even paused worlds
continue rendering and can consume every CPU core. Keep the windows and their
saves alive, then restore the user's view after measuring.

`VOXELCRAFT_TEST_URL` selects the Vite server; the intentional local default is
`http://127.0.0.1:5173`. The runner opens `/test/realtime/index.html` on that
origin. `--seed` defaults to `cedar-valley`; `--quality` accepts `low`,
`medium`, or `high`; `--duration` accepts 5–300 seconds and controls only the
continuous traversal, not startup or subsequent control scenarios.
`--width`/`--height` select the viewport. `--pixel-ratio` is an explicit,
reported resolution-only experiment, pinning the controller's bounds; omit it
for production adaptive-resolution results. Frozen build labels and production
mode are reported in the initial state.

The runner launches its **own** headless Chrome process with a fresh,
non-persistent context. It never connects to an existing browser/profile, so
manual QA saves, IndexedDB, and localStorage remain isolated. It closes only
its own context/process and leaves Vite running.

Optional `--screenshot /opt/cursor/artifacts/voxelcraft_realtime_terrain.png`
captures the real generated world after traversal measurement stops and
before any synthetic setup. It is automated-test evidence, not a manual demo.

## Coverage

The run verifies native pointer capture and actual mouse-to-camera yaw/pitch
changes first. If the installed headless browser cannot deliver pointer-lock
mouse deltas, the report explicitly says `arrow-fallback`, preserves the
failed native evidence, and warns that this is **not native-mouse proof**.
`VOXELCRAFT_REQUIRE_NATIVE_MOUSE=1` makes that limitation a functional failure.
There is no synthetic `dispatchEvent` fallback.

Native RMB is held place/use; releasing it ends use, while lost capture/focus
cancels it. Remote RMB remains drag-look with a short tap to place/use; held
Remote use is explicitly V (food, bow, shield). The separate `test:controls`
browser test covers these lifecycles and independent LMB/RMB presses.
Windowed Ctrl+W can close the browser tab: use double-tap W for sprinting or the
game's explicit fullscreen button with confirmed keyboard capture. Browser F11
alone does not capture browser shortcuts.

The main benchmark continuously traverses real generated terrain while
holding W, sprinting, strafing, looking around, and adjusting flying altitude.
It checks chunk crossings, loaded player columns, bounded caches/work queues,
and actual screen-facing rays through rendered terrain rather than a blank-sky
camera. Warmup, menu tests, and fixture construction are excluded from its
timings.

Separate real-world control checks open inventory with E, close it with E and
Escape, hold movement while overlays are open, verify no stuck keys, verify
fresh movement after closing, and check Escape/pause/resume. Pause assertions
check player position, world time, wildlife simulation clock, and vitals, not
the presentation/animation clock that intentionally keeps ticking.

Finally, a **synthetic controls-only fixture** adds a small floor and dirt wall
to the actual world while paused and unmeasured. This explicitly labeled
fixture tests the real Survival mode switch, disabled double-Space flight, a ground jump,
collision, and timed mining through a held native mouse button. Its only pose
writes are unmeasured setup. Its metrics are separate from the terrain
benchmark and must not be presented as natural terrain or demo evidence.
Mining is explicitly skipped, not passed, if native pointer capture is
unavailable. `--skip-fixture` omits this optional fixture entirely.

The separate natural-resource scenario starts a fresh Survival world and finds
an existing tree with a safe approach. One explicitly reported, unmeasured pose
placement starts near that tree; it does not inject inventory or edit terrain.
All subsequent mining, pickup walking, crafting, workbench placement, tool wear,
P-save, and reload checks use real browser controls and real game state.
E always opens the personal 2×2 grid, even beside a crafting table. The recipe
book fills that grid from owned ingredients; Shift-clicking its result extracts
the output into finite slots. Equipping moves actual stacks between the 36
inventory slots, including returning any displaced hotbar stack. After placing
the crafted table, the bot verifies that E still cannot craft a pickaxe, then
right-clicks the real table to open its 3×3 screen. It preserves ingredient
accounting through escrow and extraction, mines a natural block to wear the
owned tool, and compares canonical slots and durability after a real reload.
Its setup and timings are not traversal-performance or demo claims.
`--skip-survival` omits this longer functional check for focused performance runs.

## Measurements and failure policy

The JSON report records:
- Configuration, browser version, GPU/WebGL information, software-renderer
  detection (`true`, `false`, or unknown), elapsed time, and input counts.
- Traversal distance, displacement, unique chunks and crossings, cache,
  request/in-flight, rendered-mesh and draw/triangle maxima.
- Raw RAF interval p50/p95/p99/max, instantaneous FPS percentiles and min/max,
  average frame throughput, and jank counts/fractions above 50 and 100 ms.
- Inclusive synchronous CPU p50/p95/p99/max for `game.frame`,
  `player.update`, `graphics.rebuildDirty`, `graphics.update`,
  `graphics.render`, `wildlife.update`, and `archive.snapshot`; `bot.state`
  separately shows the read-only polling/terrain-planning cost.
- Trusted DOM-input-to-camera-update and key-to-directional-motion latencies,
  separate Arrow fallback latencies, unresolved/cancelled samples, and slow
  input examples. Existing forward motion does not satisfy a strafe sample.
- Assertions, warnings, uncaught page errors, console errors, failed requests,
  per-second progress observations, and the separately labeled control runs.
- Observed day-cycle rate against wall time, explicit clock discontinuities,
  and drawing-buffer resolution changes during adaptive rendering.

CPU phase times include instrumentation and nested calls; they are not
additive, and do not claim GPU completion. The report records post-frame and
post-player observation CPU time separately; event capture and wrapper
dispatch also add overhead. Input timing begins at DOM capture, not at the OS or CDP
sender; it does not claim input-to-photon latency. Empty samples remain null.
Primary FPS comes from unclamped RAF intervals, never the smoothed game HUD
or the simulation's capped `dt`.

Progress prints approximately once per second without agent involvement.
Functional failures, missing required traversal coverage, and page errors
exit **1**. Explicit performance-budget failures exit **2**. With no budgets,
poor software-renderer performance is reported but does not itself fail.
Native-mouse fallback or skipped mining produces `passed-with-warnings`,
never an unqualified native-input pass.

Optional environment budgets (all must be satisfied when supplied):
- `VOXELCRAFT_MAX_FRAME_P95_MS`
- `VOXELCRAFT_MAX_FRAME_P99_MS`
- `VOXELCRAFT_MAX_INPUT_P95_MS` — directional key-to-motion
- `VOXELCRAFT_MAX_MOUSE_P95_MS` — requires actual native mouse samples
- `VOXELCRAFT_MIN_FPS` — average RAF throughput
- `VOXELCRAFT_MAX_JANK_100_FRACTION` — a fraction between 0 and 1

Budgets apply to the reported renderer without silently relaxing them.
`VOXELCRAFT_BOT_TICK_MS` changes the real-time control loop interval (default
40 ms). `VOXELCRAFT_CONTROL_TIMEOUT_MS` bounds control/state waits (default
20,000 ms).

## Fast harness-only tests

These validate statistics, budget/CLI handling, continuous held-key diffs,
altitude planning, bounded requests, and measurement wrappers. They do not
launch Chrome or claim to measure game performance:

```bash
node --test test/realtime/helpers.test.mjs
```

Package scripts, mise registration, dependency installation, and the actual
headless run are coordinated by the parent task.

## Ground-continuity regression

`npm run test:streaming` uses the same frozen host with an opt-in geometry
observer. It checks continuous native forward/reverse flights at feet heights
64/104/152. Missing ground or a hidden horizon exits 2 by default; invalid or
empty measurements exit 1. `VOXELCRAFT_STREAMING_DIAGNOSTIC=1` explicitly
allows a failing baseline, never a broken test harness.
`VOXELCRAFT_STREAMING_TRANSITIONS=1` adds separately labeled quality,
teleport, and dimension API checks followed by real native flights.
Far canopies cannot count as distant ground. The sparse ray observer is included
in timing and reported separately; it is not a substitute for visual QA and
its frame rates are not observer-free gameplay benchmarks.
