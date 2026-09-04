# Cave lighting

Daylight on a surface belongs to the loaded geometry, not to the viewer's
distance from the cave mouth. Moving deeper must not extinguish an entrance
wall that remains visible. The camera's sky exposure can still fall to zero:
it controls atmosphere and visibility, not the surface-light atlas.

Normal darkness retains faint texture detail. [Minecraft's classic lighting
reference](https://minecraft.wiki/w/Light#Rendered_brightness) describes a
nonzero rendered brightness even at the lowest brightness setting. The
irradiance constants in Mineslop are calibrated through its own textured
Lambert/ACES/sRGB pipeline; they are not percentages of final displayed light.
Fullbright remains a separate inspection setting, and torches remain much
brighter than the unlit floor.

## Loaded geometry and bounded work

- `SkyColumns` records actual occluding ceilings, including edits, rather than
  trusting the terrain generator's pre-carving height.
- `SurfaceTopology` compares exact occlusion bitsets and ceiling values.
  Light-irrelevant changes, such as water-level changes, do not invalidate
  already computed illumination.
- `SurfaceDaylight` propagates diffuse skylight through loaded, six-connected
  non-occluding cells within a 16-block halo. Opaque and unknown cells block it.
  Partial occluders conservatively block their whole voxel.
- A bounded texture-array atlas supplies per-surface values to the existing
  material pipeline. Its 81 layers support the existing 384-block maximum
  vertical span and signed world coordinates.
- Work is capped at two lighting-tile builds and 18 topology verifications per
  update. Age-stable, complete dependency groups prevent continually changing
  nearby chunks from starving older tiles.
- Actual closures invalidate old illumination immediately. Pending verification
  is not treated as valid light. Warm, unchanged views reuse cached geometry
  and do not rebuild or upload atlas layers.

This adds bounded CPU work and memory; it is not a claim of zero-cost rendering.
Cold or heavily edited regions still cost more than warm views. The native
timing probe reports individual update costs separately from multi-tick
initialization and does not treat those numbers as a gameplay FPS benchmark.

These are render-only caches. They do not change saved worlds, generator
versions, collision, fluid simulation, or gameplay light rules. Block-light
sources still use the existing bounded local-light renderer.

## GPU context recovery

The terrain and emission atlases retain their original CPU pixels with the
existing UV orientation, gutters, filtering and color space. Icon-source and
glow canvases repaint on restoration.

GPU resources release their old-context handles while the context is lost.
Scene traversal is supplemented by explicit retained-resource owners, including
cached held-item textures and expired-arrow geometry/materials. World data,
CPU geometry, morph data and scene membership remain intact.

Every retained texture-array layer stays dirty until the first restored upload.
Partial streaming while the context is lost must not leave otherwise unchanged
atlas layers blank. Shadow data is refreshed after restoration.

## Verification

Use a separate local server/profile so existing saves are not replaced:

```sh
mise run --tool node@22.14.0 start
export VOXELCRAFT_TEST_URL=http://127.0.0.1:5173/mineslop/
mise run --tool node@22.14.0 test:lighting-depth
mise run --tool node@22.14.0 test:lighting-context
mise run --tool node@22.14.0 test:lighting
mise run --tool node@22.14.0 test:lighting-game
mise run --tool node@22.14.0 test:lighting-recovery
mise run --tool node@22.14.0 test:lighting-native
```

The depth GPU fixture samples the same texels across a 79-block observer sweep,
plus an unlit floor, real torch contrast, Fullbright, and opaque closures.
Its fog removal is explicitly fixture-only. Full-Game tests use ordinary
materials and fog, trace GL errors, compare terrain pixels across an isolated
GPU restart, and exercise off-scene resource cleanup.

Manual acceptance also walks the complete native `cedar-valley` entrance path
from `(60.5, 37, 986.5)` to approximately `(60.5, 16, 916.5)`. Capture the
outside approach, successive interior views, look-backs on both sides of the
old 16-block cutoff, and the deepest forward/back views. Keep Fullbright off,
use real walking input, and make no terrain edits during the comparison.
The CPU native-path probe is not a substitute for that GUI walkthrough.

## Local acceptance

The complete corridor was walked on
`b9bcb50aca1ae822d4813eea2a67d6ecc9ad4f06`, with 15 captured views covering
the outside approach, both sides of the former cutoff, and full-depth wall,
floor and entrance-facing views. The run covered 69.8 horizontal blocks with
zero terrain edits, no player-placed lights, Fullbright off, and no GL errors
or context losses. Creative mode prevented combat interruption; movement and
look used real OS input, not scripted pose changes. Natural Glow berries and
Sculk remained in the world.

The entrance-adjacent surfaces remained visible beyond the old 16-block cutoff,
and deep stone/moss retained dim texture detail. Source-free darkness and torch
contrast were also verified in the separate controlled GPU fixture.

The complete unit comparison has 3,764 passes out of 3,782 tests, with the same
18 pre-existing failures as the pre-lighting baseline and no new or changed
failure assertions. Depth/context/recovery GPU checks, the production build,
and both Pages entrypoint/worker/save-reload checks pass.

The existing 45-second cold-canopy horizon warmup test remains red on both
baseline and candidate: canopy construction does not finish within its bound
on this VM. Its gate is not weakened or waived. The native GUI walkthrough is
separate evidence, and these software-rendered captures do not establish
hardware-GPU frame-rate parity.
