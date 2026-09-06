# Bounded native geometry capacity

`regional-native-geometry.measure.mjs` restores the historical measurement from
`/home/ubuntu/projects/mineslop-recovery/regional/reconstructed/test/regional-native-geometry.measure.mjs`.
Every import resolves against this primary checkout, never recovery `src`.
Only test fixtures and measurement code opt into regional packing. Water fusion
remains off; this baseline cannot establish fused R12 acceptance.

The fixture generates the native version/dimension packets without changing
height or terrain. Its explicit dependency radius is `R + 2`, maintained during
eastward travel too. R12 means 841 input columns, exactly 625 full-detail output
columns, and all 15,000 sections for v7 overworld (including empty sections).
Coverage, acknowledged dirty tickets, and captured revision/incarnation stamps
must all agree. LOD is not a substitute.

The historical ceilings remain 256 MiB GPU, 256 MiB combined CPU, 16 MiB staging,
1,024 draws, and 1 MiB copy per paced slice. Independent accounting traverses
scene geometries, deduplicates actual attribute/index backing buffers, and
compares their allocated byte lengths with both canonical CPU and GPU ledgers
after subtracting the separately accounted palette. Resource peaks must also
fit the same limits.

## Run

Check setup has completed, and use explicit `mise exec node@24`. Run each command
in a dedicated tmux session and keep monitoring until it exits. Preserve stdout
and stderr together under `/opt/cursor/artifacts`.

First run:

```sh
mise exec node@24 -- node --test test/regional-native-fixture.test.js
NATIVE_RADIUS=1 NATIVE_VERSION=7 NATIVE_LEGACY_ADAPTER=0 \
NATIVE_LIFECYCLE=1 NATIVE_WALL_SECONDS=30 NATIVE_HARD_SECONDS=45 \
mise exec node@24 -- node test/regional-native-geometry.run.mjs
```

Then one bounded current-source baseline capacity probe:

```sh
NATIVE_RADIUS=12 NATIVE_VERSION=7 NATIVE_DIMENSION=overworld \
NATIVE_SEED=cedar-valley NATIVE_CX=0 NATIVE_CZ=0 \
NATIVE_LEGACY_ADAPTER=0 NATIVE_LIFECYCLE=0 NATIVE_FLUSH=0 NATIVE_PROGRESS=1 \
NATIVE_WALL_SECONDS=170 NATIVE_HARD_SECONDS=230 \
mise exec node@24 -- node test/regional-native-geometry.run.mjs
```

The launcher hashes primary sources before and after, records the current HEAD,
and starts the hard timer before child imports/generation. The timer terminates
only its child PID, escalating after three seconds if necessary. It does not
stop services. Provenance defaults to timestamped files in `/opt/cursor/artifacts`;
`NATIVE_PROVENANCE` supplies a custom prefix.

The internal deadline includes generation; generation progress is emitted every
25 columns, and checkpoints occur before each column. Geometry uses a tighter
measurement-only 2 ms scheduler budget, not a throughput benchmark. Individual
synchronous operations can exceed that slice budget; report measured maxima.
`NATIVE_FLUSH=1` is capacity-only and bypasses pacing, never admission ceilings.
The external process deadline remains mandatory with flush because a synchronous
rebuild cannot be interrupted by the measurement's own loop.

On refusal/deadline, preserve the final JSON and progress, including exact fresh
columns/sections, installed sections, draw calls, CPU/GPU/staging peaks, phase,
stop reason, and independent accounting result. An external kill only establishes
the last emitted progress, not a final exact snapshot. Start/end hash mismatches
identify concurrent disk changes and must be disclosed; hashes are not a trace
of the actual ESM-loaded source.

This is CPU geometry-capacity evidence using a fixture atlas and host. It does
not qualify World streaming, full lighting, hardware GPU behavior, frame rate,
fused R12, or all-biome lifecycle performance. Do not widen caps or launch a
large jungle/all-biome lifecycle sweep to turn a failed baseline green.
