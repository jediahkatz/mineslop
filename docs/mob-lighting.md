# Location-based mob daylight

The [lighting-only release](https://github.com/jediahkatz/mineslop/commit/3f00fbd1b9d035e22d714167b5b1f86b495d45a2)
corrects observer-dependent creature lighting without changing cave brightness,
fog calibration, terrain generation or saves.

Previously, terrain sampled its world-position daylight field while creature
materials used observer-adjusted scene lights. A stationary outdoor cow could
therefore turn black merely because the player entered a cave.

Opaque and lazily created translucent creature batches now bind the current
scene's daylight field at draw time. Shader coordinates apply batching,
instancing and world transforms in that order. Original skin, emissive and local
light shader behavior remains composed with the daylight hook. Retained
materials rebind between scenes without sampling a disposed renderer's field.

## Verification

- A lighting-only checkpoint, based on the deployed game, passes 26 focused
  daylight/topology/material tests, the production build, and both Pages
  worker/save-reload checks.
- At fixed noon, the same creature texels remain identical through 15 ordinary
  observer positions, including overhead, inside, deep and returned views.
  Native voxel hashes, terrain texels and Fullbright/restoration remain unchanged.
  Separate glowing-eye, fire and torch readbacks pass with no GL/shader errors.
- Real keyboard input walks into the native entrance and turns back toward the
  outdoor cow. Both creatures remain visibly lit. The two stationary models are
  render-only diagnostics using the live Wildlife material, not natural spawn or
  Survival acquisition evidence. No terrain edits or placed lights are involved.

## Scope of the white-entrance report

The pale patch in this sampled entrance is exposed Stone (block 3), with full
daylight and zero fog contribution. The sampled deep floor remains dark. These
observations do not establish that every reported white-haze location is
explained; another affected entrance needs its own screenshot/coordinates.

The GUI recording comes from an overloaded software-rendering VM. It verifies
lighting behavior, not hardware frame-rate performance.
