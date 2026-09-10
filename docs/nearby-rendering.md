# Nearby rendering

Nearby is the default performance fallback in Video settings. It renders native
nearby blocks without the distant terrain, vegetation, seam or landmark owner.
This is a rendering-policy change, not a checkout of an older game revision.
World generation, existing edits, item systems and save formats are unchanged.

## Controls and preferences

- With no new mode preference, Fast/Balanced/Fancy start at radii 2/3/4.
- Choosing a Nearby distance pins that choice between 2 and 4, independently of
  later Graphics changes.
- Extended (experimental) restores distant rendering and the remembered
  independent 2–12 native-chunk distance. Both mode-specific choices survive
  switching away and back.
- Mode and Nearby distance use `voxelcraft-render-mode-v1`. The prior
  `voxelcraft-render-distance-v1` value remains the Extended preference. Loading,
  switching mode or choosing a Nearby distance never rewrites its raw bytes.
  An explicit Extended slider change retains the existing behavior of updating
  that preference.
- These settings stay in the browser. They are not added to world exports or
  copied into another browser by a world import.

Graphics quality keeps its existing save behavior: importing a world restores
that world's saved quality. Explicit Nearby and Extended distances remain the
browser's independent choices even when the restored quality differs.

The selector, slider bounds and displayed distance change only after the host
accepts them. Rejected requests do not become saved preferences. A browser
storage failure is reported as a session-only change. Quality, mode and distance
requests are refused while loading, failed or transitioning; the controls keep
their last confirmed values.

“Extended” here is unrelated to the “Expanded (experimental)” **world-generation**
choice: switching rendering mode never changes a world's generator version.

## Runtime boundary

`VoxelGame.prepareGraphics()` selects the optional distant owner before
construction. Runtime changes use `GameRenderer.configureTerrain()` on the same
renderer; world-event bindings, native materials, player and world owners remain
in place.

Nearby skips both `DistantTerrain` construction and the per-frame distant
batch/boundary preparation and update. Disabling Extended disposes its geometry,
textures, scene listeners and pre-render hook, drops renderer-side handoff
caches, and resets expanded fog. Re-entry binds the new owner to current
daylight, including when daylight was initialized while Nearby was active.

Native section meshing, regional packing, target overlays, local/daylight
lighting, conservative streaming fog, cave/high-flight fog and water/lava
presentation continue. Nearby End blocks remain native; far End landmarks are
intentionally unavailable until they enter native view.

Native mesh boundary certificates are still built. Keeping them permits a
normal Extended re-entry without a special certificate-rebuilding pass. This
fallback does not claim to remove every cost introduced by the distance work.
Water fusion and tail sealing remain disabled in the main app.

## Loaded area and limits

Native distance also drives normal World streaming. Away from world edges and
additional pinned footprints, the source/shape halo is R+2: 81/121/169 input
columns at Nearby R2/R3/R4, versus 841 at R12. Shrinking cancels obsolete work
and evicts out-of-range residency through the existing World lifecycle.

This restores a smaller simulation area too: unloaded stations and retained
creatures follow their normal pause/retention rules, and ordinary mobs follow
normal unload behavior. It does not keep a hidden R12 simulation running behind
a short view. Saved edits and retained owners must survive leaving and returning.
The 841-column and two-physical-worker maxima are unchanged.

## Verification scope

The focused CPU contracts cover preferences, confirmed UI updates, renderer
ownership and cleanup, late daylight binding, native fog across dimensions and
fluids, and bounded streaming shrink/re-entry:

```sh
node --experimental-test-module-mocks --test --test-concurrency=1 \
  test/render-mode-preferences.test.js test/game-render-distance.test.js \
  test/game-render-mode-setup.test.js test/ui-render-distance-settings.test.js \
  test/ui-quality-settings.test.js test/renderer-nearby.test.js \
  test/renderer-streaming.test.js test/nearby-streaming-lifecycle.test.js
```

The streaming tests distinguish real World scheduling with controlled worker
packets, small authored section/LOD hosts, one targeted native edited section,
and retained horse/fluid continuations. They retain the 96-update completion
bound and production resource ceilings. They do not establish a complete
rendered R2/R3 scene or a composed Game lifecycle.

`test/render-mode.browser.integration.mjs` is an opt-in compiled main-app test.
It checks actual Video controls, unchanged raw Extended preference bytes,
Survival input/pickup, UI downloads, cold reload and file import. Its native cod
encounter uses supplied gear and an authored starting approach, not from-zero
progression. Run it on an isolated preview origin under the VM's normal
parent-controlled GPU lease and private-browser checks:

```sh
NEARBY_RENDER_URL=http://127.0.0.1:5183/mineslop/ \
  node --test test/render-mode.browser.integration.mjs
```

Browser input/resource/save verification and measured frame pacing are separate
requirements. The realtime harness supports explicit mode/distance comparisons;
see `test/realtime/README.md`. Its test-only instrumentation is not the main
entrypoint, and software-renderer numbers cannot establish target-hardware
smoothness. A loaded-input count is not proof of completed geometry or lighting.

Historical native-R12, lighting, ownership and full-scene gate failures remain
unqualified. This fallback does not promote sealed renderer candidates or close
the wider integrated world/item acceptance goal.

## Measured limits (2026-09-10)

The clean frozen candidate passes 312 focused Node checks, the compiled main-app
settings/Survival pickup/save/reload/import test, and both Pages asset/save smoke
checks. These establish functionality and persistence, not smooth rendering.

Four 45-second production-build flights used the same seed, Balanced quality,
1280×720 viewport and fixed pixel ratio 1, in reversed mode order. The VM uses
SwiftShader software WebGL:

| Run | Average FPS | Frame p95 | Terrain-in-view samples |
| --- | ---: | ---: | ---: |
| Extended R12, first | 3.37 | 466.6 ms | 71/71 |
| Nearby R3, first | 6.49 | 333.4 ms | 28/77 — fails the 40% minimum |
| Nearby R3, second | 4.26 | 400.0 ms | 69/72 |
| Extended R12, second | 2.66 | 550.0 ms | 68/68 |

All four pass native input, loaded-player travel, work limits and menu/pause
controls. However, one Nearby flight loses too much terrain visibility, and
the runs cover substantially different distances as long frames slow the
simulation. The higher FPS is therefore **not a qualified performance win**.
Fast-flight visibility, repeatable frame pacing and target-hardware smoothness
remain open; none of the acceptance thresholds have been lowered.
