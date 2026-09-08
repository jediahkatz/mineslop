# Native renderer benchmark

This is a test-only real `VoxelGame.start()` host. It runs native generation,
normal `requestAnimationFrame`, production streaming/meshing quotas, and trusted
browser pan/walk input. It does **not** drain queues, author terrain, install a
fake clock, infer readiness from loaded chunks, or change streaming/mesh budgets.

## Run

From the repository root, with installed dependencies:

```sh
node --test test/render-benchmark/*.test.mjs
BENCH_SOURCE_REF=<full-commit-sha> node test/render-benchmark/freeze.mjs
# The freezer prints a /tmp/mineslop-frozen-* directory. Work there next.
cd /tmp/mineslop-frozen-PRINTED_SUFFIX
BENCH_PORT=6789 node test/render-benchmark/serve.mjs
```

Keep the server in a named tmux session. In another terminal:

```sh
VOXELCRAFT_TEST_URL=http://127.0.0.1:6789/mineslop/ \
  BENCH_CAPTURE=performance BENCH_OUTPUT=/tmp/classic-timing-UNIQUE node test/render-benchmark/run.mjs
# Nonzero is expected for performance-only: correctness is unavailable.
# Run sequentially, never concurrently; use the SAME frozen directory/server.
VOXELCRAFT_TEST_URL=http://127.0.0.1:6789/mineslop/ \
  BENCH_CAPTURE=correctness BENCH_OUTPUT=/tmp/classic-correctness-UNIQUE node test/render-benchmark/run.mjs
node test/render-benchmark/link.mjs /tmp/classic-timing-UNIQUE/run.json \
  /tmp/classic-correctness-UNIQUE/run.json /tmp/classic-linked-UNIQUE
```

`BENCH_SCENE=classic|expanded|river` selects `cedar-valley` v3,
`cedar-valley` v7, or the `birch-river` v3 foliage/water **candidate**.
`BENCH_SECONDS=30` defaults to 30 (allowed 20–120). The browser has an additional
75-second total startup/control allowance; individual startup/lifecycle/cleanup
waits are bounded. Publishing artifacts happens after the browser closes and is
not included in frame measurements. `BENCH_OUTPUT` must be a new directory;
default output is a timestamped directory under `/opt/cursor/artifacts`.
`BENCH_CONTROLS=0` skips post-measurement controls and leaves those gates unavailable.
`CHROME_BIN` selects the browser executable.

Each run uses a fresh browser context, empty cookies/IndexedDB/localStorage,
800×500 viewport, DPR 1, medium quality, default R12, Survival, and remote mouse
controls. The only initialization argument changes are seed and generation
version; no archive is injected.
The real render-scale controller is configured with minimum = maximum = the
quality/DPR cap, fixing raster dimensions (800×500 for medium/DPR 1). This
explicit benchmark setting prevents expensive correctness observers or a slow
GPU from silently lowering resolution. Samples and final GL dimensions must
agree; adaptive-raster captures cannot be used for paired speed acceptance.

The finite input route is: natural spawn, Play, stationary four seconds, paid
near edit, two seconds settling, mouse +60/+15 in 12 steps, W for three seconds,
inverse pan, then stationary until the wall-time bound. World collision and
normal dt clamping remain active. Thus this is a deterministic **input route**,
not a forced identical pose trajectory; actual sampled poses/yaw/pitch are
recorded. Paired acceptance rejects final horizontal divergence above two blocks.
Correctness captures have expensive observers and are never speed baselines.
Performance captures have no resource/native/mask/region census, rays, readbacks,
or screenshots while recording. Recurring observers are scalar telemetry and
constant-size edit ticket/map checks; each has a default 1 ms maximum overhead
gate. No overhead subtraction is claimed.
Timing samples stay in browser memory until the final collection; no live
browser-to-runner sample serialization runs inside the performance observer.

The paid edit uses the same real hand-cost/voxel transaction as the existing live
render-distance integration test. A disclosed two-stone inventory fixture funds
one ordinary block placement into nearby natural air. Timing starts before
hand-cost/mutation preparation and includes commit, excluding inventory setup.
A required far corner section must still be absent at submission.
Performance `publicationMs` measures ticket acknowledgement, not visual proof.
Correctness `visibleMs` verifies the debit,
new voxel, acknowledged revision ticket, mounted geometry, and a physical top
face ray hit. It is not a test of gathering/crafting or mouse placement aiming.
The `editMs` deadline (default 1,000 ms) applies to **clean** transaction and
publication times, including preparation and commit. Candidate 5,000 ms does not
pass because baseline is 6,000 ms. Observer-heavy physical proof uses the separate
`correctnessProofMs` bound (default 10,000 ms); the observer stops checking after
that bound. A 100 ms clean edit plus 1,447 ms physical proof can pass. Missing or
late physical proof still prevents qualification; it is not an FPS/latency metric.

## Freeze before comparing concurrent changes

Live Vite/independent unverified URLs are rejected. Freeze each revision:

```sh
# Current dirty worktree, including renderer changes:
BENCH_SOURCE_WORKTREE=1 node test/render-benchmark/freeze.mjs

# Clean committed renderer baseline:
BENCH_SOURCE_REF=<full-commit-sha> node test/render-benchmark/freeze.mjs
```

The command prints a temporary test checkout and serve/run commands. It never
moves the worktree's branch and never modifies production files. Serve different
snapshots on distinct ports. Test code is copied from the current worktree for
both sides; dependencies are symlinked, with installed versions and lockfile
hashes recorded. Do not edit dependencies during trials.
Worktree capture is explicit opt-in: it includes **all** source/package changes,
not just renderer edits. Prefer a clean ref plus an explicitly reviewed patch
when unrelated work is present. Tracked staged and unstaged changes are recorded.
One static Vite bundle is built and its assets are SHA-256 sealed. The static
server loads verified bytes into memory. Before startup the runner compares the
remote manifest, hashes every fetched asset, then fulfills browser requests from
those verified bytes; unmanifested requests abort. Local input hashing alone is
not treated as served-source proof.
`BENCH_SOURCE_PATCH=/absolute/path.patch` optionally applies a captured patch to
the temporary committed snapshot. Verify the resulting provenance: a patch from
a concurrently edited worktree may already include the fix.

Per-run artifacts include source-file SHA-256s, commit SHA, branch, dirty source
diff, before/after provenance, dependency versions, host/CPU/browser/WebGL
renderer details, `run.json`, raw `samples.jsonl`, readable `summary.txt`,
`run.log`, post-timing settled screenshots, and A/B/A control PNGs when exercised.
Artifact writes use local buffers and publish completed files once, so remote
artifact-store append latency cannot pace the game.

## What the measurements mean

- Native rings use every required vertical section, current revision stamps,
  scene attachment, camera layers, and physically backed section ranges.
  Nonempty physical columns are separate from fully fresh columns; completed
  empty sections can own intentional absence but cannot establish nonempty
  evidence. A contiguous full R12 square means all 625 columns, not one distant
  mesh, and the UI's 192-block target is reported explicitly.
- First useful neighborhood is strictly defined as fully fresh R1 with
  nonempty underfoot geometry. Missing/unreached values are `null`, not zero.
- 64/128/192-block thresholds separate full native readiness, sparse four-axis
  fallback ground intersections with fog transmission, and fog-only reach.
  `visibleFallbackCandidateMs` additionally requires a point in the actual
  frustum with non-negligible view-depth transmission and no sampled native
  terrain-height occlusion. It remains a candidate: two-block terrain sampling
  does not model foliage, caves, or all thin occluders. None of these is continuous
  horizon/pixel coverage. Ground rays exclude distant canopy geometry.
- Fog attenuation uses Three's smoothstep of forward view depth, not Euclidean
  distance. No visibility claim is inferred from an effective/requested radius.
- Frame intervals report p50/p95/p99/max. Update, meshing, draw submission,
  whole-Game-frame, observer, and long-task durations are separate. Nested
  durations must not be added. GL submission wall time is not GPU execution time.
- GPU/CPU/staging and terrain draw caps combine native renderer accounting
  (including admission peaks) with live/pending LOD terrain, vegetation,
  landmarks, seam geometry/height textures and owned backing arrays.
  CPU backing deduplicates by ArrayBuffer identity. GPU reservations deduplicate
  by BufferAttribute/interleaved-buffer/texture identity: distinct upload objects
  sharing CPU memory still allocate separately on the GPU. Pending-only backing
  contributes to staging; JS numeric payload is charged at 8 bytes/element.
  The expensive census runs only in correctness captures, at renderer-update
  boundaries. Transient allocations wholly created/disposed within one update,
  engine array spare capacity and object headers are not directly observable.
  Actual full-scene draw counts
  and Three memory object counts are reported separately. These are **not** total
  browser/driver VRAM or heap bytes. Copy bytes are observed per mesh slice.
  GL buffer uploads/allocations and detail-mask texture uploads are counted;
  other texture transfers remain explicitly unavailable.
- Every census includes both present and absent ownership-mask slots. Sparse
  nine-screen-ray checks compare independently raycast loaded native opaque
  cubes against mounted physical native/fallback geometry and shader ownership.
  Unknown residency, no opaque expectation, fog hiding, approximate fallback,
  and physical occlusion are distinct outcomes. Rays do not validate alpha-cutout
  leaf pixels. No relevant visible rays means **unavailable**, not pass.
- After timing stops, synchronous A/B/A rendering hides native roots without
  changing LOD ownership, deliberately introducing holes. Changed pixels must
  be nonzero, and restoring roots must reproduce A exactly. This is a
  sensitivity/restoration control, not a blanket no-flicker claim.
- The native lifecycle control loses/restores the real WebGL context, observes
  resource-disposal events, then requires a post-restore render and the same A/B/A
  positive native-surface/pixel control at the paid block's fixed pose. Restored
  context flags plus CPU meshes alone cannot pass. It then exercises real Game
  world replacement and verifies old renderer teardown. Loss-window errors are
  preserved separately as `controlErrors`; failed recovery remains a failed gate.

Run the existing physical/mask validators alongside this harness:

```sh
node --test test/lighting-physical-geometry.test.js test/distant-detail-mask.test.js \
  test/realtime/mesh-budget.test.mjs test/render-benchmark/*.test.mjs
```

The benchmark's structural tests deliberately inject missing/duplicate surfaces,
empty observations, stale edits, mask mismatches, memory/copy/draw overflow,
unavailable visual/lifecycle evidence, altered provenance, missing trials,
route divergence, and frame/edit regressions. Those fixtures are oracle tests,
never native-world performance evidence. Existing shader-only controls such as
`test/distant-surface.gpu.integration.mjs` can supplement, not replace, the native
route.

## Hard constraints and hill-climbing

Default exit is nonzero for failed **or incomplete hard gates**, after preserving
the capture. `BENCH_DIAGNOSTIC_ONLY=1` explicitly opts into capture-only success;
infrastructure/startup/provenance-fetch failures still fail. The old `BENCH_STRICT`
opt-in behavior is removed. Frame/R12 targets stay separate and cannot certify
hardware from software-renderer timings. JSON `evaluation.hardStatus` is authoritative.
`BENCH_CONSTRAINTS=/path/to.json` overrides positive numeric defaults:
R12/192 blocks, p95 frame interval 16.7 ms, first useful R1 within 5,000 ms, paid
edit within 1,000 ms, 256 MiB canonical GPU and combined CPU, 16 MiB staging,
1,024 terrain draws, and 1 MiB copy per slice. Changing a target must be reported,
not used to relabel an unchanged failing result as an optimization.
Linking requires identical complete constraint sets, re-evaluates both raw captures
under their recorded limits, and retains copied validated limits in the linked
record and correctness evidence. Comparing requires that same constraint set in
every baseline/candidate trial and its linked proof. A 512 MiB GPU proof validated
under 1 GiB cannot support timing claiming 256 MiB.

Dense-river scene census gates are correctness-only: performance reports
`unavailable`, not failure or pass. Only matching positive correctness evidence
can satisfy them during linking. Missing, failed, or mismatched proof is rejected.

Stop on correctness/budget failures. Fix ownership/holes/stale edits/lifecycle
before optimizing a score. There is no aggregate score that permits a visual
regression in exchange for speed.

Once correctness passes, run at least three alternating A/B pairs per scene,
with an unchanged browser, viewport, dependency/harness hashes and machine.
First link each timing capture to its same-source, same-route correctness capture
using `link.mjs`. Link failures stay nonzero and cannot overwrite existing output.
Do not run other render benchmarks concurrently. Compare **linked** records:

```sh
node test/render-benchmark/compare.mjs A1/run.json A2/run.json A3/run.json -- \
  B1/run.json B2/run.json B3/run.json
```

Acceptance requires every candidate hard gate to pass, a repeatable improvement
in clean meshing (all paired changes improve, median ≥5%), and
no pair with >5% clean p95-frame or publication-latency regression. The absolute
clean edit deadline also applies independently of relative improvement.
Observer-heavy readiness/visibility and physical-proof times remain diagnostics,
not comparison metrics. Relative-change distributions
and standard deviations are reported; noisy/borderline results need more pairs,
not a larger score. A previously failing baseline is allowed as evidence, but
cannot excuse a failing candidate. This is optimization acceptance, not release
qualification: R12 and frame targets remain separate.

Each side must have one fixed source identity and one fixed bundle manifest
across repetitions, with explicit ref/patch provenance. Three pairs from three
different source groups are rejected. Legacy/contaminated timings, mismatched
independent controls and missing overhead evidence cannot pass.

## Historical captures: unqualified

Preserve earlier captures unchanged. All pre-audit captures (including old
`render_baseline_*`, `render_verified_*_20260907`, and `/tmp/render-*-smoke`)
are **unqualified for speed comparison**, regardless of old filenames/pass flags.
They mixed synchronous census/raycast and screenshots into RAF timings. The
observed 63.3 ms p95 / 72.6 ms maximum observer is contamination, not renderer
cost. Measurement versions before 3 cannot enter `compare.mjs`. Keep their
images/witnesses only as historical diagnostics.
Pre-fixed-raster audit attempts also remain unqualified for paired acceptance;
do not rewrite their recorded machine/raster data to force a match.
See `WITNESS-NOTES.md` for the reproduced empty-publication stale-cache defect
and the distinction between normal-RAF lifecycle exceptions and missing pixels.

SwiftShader/llvmpipe results are diagnostics, never hardware FPS qualification.
Paired CPU/main-thread comparisons remain useful with identical instrumentation
and environment. Report concurrent system load as a caveat.

## Matrix coverage and next action

Classic spawn alone cannot validate expanded terrain, tall-section occupancy,
dense foliage/river views, End/cave surfaces, or a long-distance walk.
Each scene reports a native R2 spawn input profile (leaf/water cells and biomes).
The river seed is a **candidate**, not a certified dense route: inspect the
profile/screenshots and pin a finite richer route if it lacks the intended
foliage/water distribution. Do not claim all scenes passed from one capture.

Start with a short clean baseline and a matching fixed-revision candidate.
Inspect hard failures, native rings and visibility thresholds, then run the
three-pair comparison only after hard gates pass. If the requested R12 horizon
is still unreached, extend the *bounded* run to at most 120 seconds or improve the
renderer; never replace real scheduling with a readiness drain.
