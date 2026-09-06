# Experimental cold R4 tail sealing

This is a CPU prototype, not a game setting or a production/R12 qualification.
There is no default, URL, UI, or quality-preset activation.

## Explicit opt-in

```js
import { beginExperimentalColdTailEpoch } from "../src/experimental-tail-sealing.js";

renderer.renderDistanceOverride = 4;
renderer.meshLimits = {
  ...renderer.meshLimits,
  regionalPages: true,
  experimentalColdTailSealing: true,
};
if (!beginExperimentalColdTailEpoch(renderer)) {
  // Unsupported input/renderer state: the existing planner remains in use.
}
```

Setting the boolean alone does not arm the experiment. Arming requires an empty
renderer, no jobs/compaction/fusion, a resident input set of at most 169 versioned
chunks, a radius no greater than four, and the world's monotonic
`_nextDirtyTicket` clock. It settles normal initialization with a zero-work slice.
The authored CPU fixture exposes the same clock as `World`; acknowledgements do
not increment it.

The epoch captures world/generator/dimension/epoch identity, the mutation clock,
chunk identities/incarnations/revisions, view center/radius, configuration and
material identities/versions. Edits, unload/ABA, view or configuration changes,
fusion and scheduler clearing permanently invalidate it. Invalidation drops
captured world/chunk references. A missing section key is never sufficient
eligibility, and toggling the flag back on cannot rearm a populated renderer.

## Packing and fallback

- Append whole compatible sources, with a fixed 65,532-vertex threshold.
- Reuse sealed complete owners; rebuild only a compatible unsealed tail when
  the next whole source fits. Keep exact allocations and existing physical caps.
- Keep transparency on its existing independent objects and physical passes.
- Use the existing copying, exact palette leases, prepared range views and
  revision-validated publication.
- Preflight the old dense planner without allocating its buffers. Check its
  projection against fresh CPU/GPU/staging/draw admission data on every slice.
- Unsupported formats, replacement/dead ranges, compaction, oversized sources,
  or a dense preflight beyond the experimental reserve use the old planner.
  Failed candidate admission disposes private copies and retries the same meshed
  source through that planner; it does not acknowledge or throw away the source.
- An 8MiB fallback reserve stays inside the existing caps while the epoch is
  active or any sealed physical lease survives. A buffer-free numeric lease
  count includes private copies and detached retirement. GPU context disposal
  does not release it; explicit physical retirement does. A larger configured
  compaction headroom is never reduced.

Future dense work still needs honest admission. Work which cannot fit the old
planner's physical/capacity bounds keeps its dirty ticket and prior visible
geometry. This experiment does not promise progress for arbitrarily large edits
or for ceilings lowered beneath resident ownership.

## Tests

```sh
node --test test/experimental-tail-sealing.test.js
node --test --test-concurrency=1 test/experimental-tail-sealing.test.js \
  test/section-*.test.js test/*regional*.test.js test/renderer-sections.test.js \
  test/renderer-water-*.test.js test/water-fusion-*.test.js
```

The tests compare decoded indexed triangles, normals, UV and RGB values, not
layout hashes. They exercise thresholds, oversized sources, index/attribute/
palette-width promotion, actual palette exhaustion, allocation/copy/range/
precommit failure, cold-epoch invalidation, private/detached retirement, context
loss, capacity refusal/retry, dense fallback with retained owners and larger
headroom, unfused transparency and compaction.

The bounded native benchmark uses independent Node processes, the same 169
inputs and 1,944 required fresh sections, 2ms rebuild budgets, equal 8-second
observation windows and unchanged caps. It buffers per-call telemetry, measures
internal census time with a process-local loader, and performs independent final
backing/palette/submission accounting after the window. The archived loader does
not write application sources. Measured admission peaks are not a replay of every
transient allocation. GPU controls remain a separate acceptance requirement.

### Authored experimental GPU integration

With the existing Vite server serving this checkout:

```sh
TMPDIR=/home/ubuntu/projects/mineslop-recovery/b \
TAIL_SEALING_GPU_URL=http://127.0.0.1:6795/mineslop/ \
TAIL_SEALING_GPU_REPORT=/opt/cursor/artifacts/tail_sealing_gpu.json \
timeout --signal=TERM --kill-after=5s 200s \
  mise exec node@24.18.1 -- node --test \
  test/experimental-tail-sealing.gpu.integration.mjs
```

This automated SwiftShader test uses one actual `GameRenderer`, atlas, camera,
and frozen lighting state. A bounded authored input meshes 110,592 vertices:
one baseline Uint32 page versus two 55,296-vertex candidate Uint16 pages. It
requires an actual sealed owner retained through another source publication,
actual GL draws sampling both geometry and block-light palettes, equal submitted
index coverage, and exact RGBA equality. Hiding the geometry must change pixels.

The real context callbacks must retain arrays, palette references and the 8MiB
reserve, then reupload and recover the exact image. An edit invalidates the epoch;
dense fallback must keep prior backing/reserve until physical retirement and
match a fresh edited baseline. Actual GL buffer/texture deletion, zero final
renderer allocation counts, zero palette references and zero sealed leases are
asserted. The report and candidate PNG are written only after all checks pass.
Source hashes verify that the served files match disk and remain unchanged.

Bounds are 1,500 frames per settle, 120 seconds inside the probe, a 180-second
test timeout and the external 200-second backstop; mesh caps are unchanged.
This is a color-pass representation/context/disposal control, not a native R4
GPU throughput, hardware FPS, or shadow-performance qualification.
