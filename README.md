# Voxelcraft

An original Minecraft-inspired survival and creative sandbox running entirely in
a desktop browser. No account, backend, remote assets, or API keys are required.

## Play locally

From this directory, run `npm ci`, then `npm run dev`, and open
the local URL printed by Vite (port 5173). The same workflows are available as
`npm run build`, `npm test`, and the `test:*` scripts listed in `package.json`.
If you use [mise](https://mise.jdx.dev/), `mise run start`, `mise run build`,
and `mise run test` wrap those commands.

`npm run build` produces a static site in `dist/`; `npm run preview` serves that
build locally. The game requires WebGL 2 and a mouse and keyboard.

## GitHub Pages

The deployment target is [jediahkatz.github.io/voxelcraft](https://jediahkatz.github.io/voxelcraft/).
Vite uses `/voxelcraft/` as its base for scripts, styles, fonts, icons and the
terrain worker. Local development and preview use the same path on port 5173.

In [repository Settings → Pages](https://github.com/jediahkatz/voxelcraft/settings/pages),
choose **GitHub Actions** as the source. The `Deploy Voxelcraft to GitHub Pages`
workflow builds and tests pushes to `main` (or a manual run on `main`), then
publishes only `dist/`. The build has read-only repository access; only the
deployment job receives Pages and OIDC write permissions.

The repository can remain private on a GitHub plan that supports private-repo
Pages. The deployed game is public; no source-visibility change is automatic.
Worlds and preferences stay in the visitor's browser. To move a localhost
world to Pages, use **Export Save...** locally and **Import Save...** on the
hosted game; different origins cannot share browser storage.

To verify the deployment layout before publishing:

```bash
npm ci
npm run build
npx playwright install chromium
npm run test:pages
```

The smoke test serves only `/voxelcraft/`, with no root-asset or SPA fallback.
It checks asset paths, native worker startup, WebGL2, real save/reload, and
device preferences in a fresh browser profile. `CHROME_BIN` can select an
already installed Chrome instead of downloading Playwright's browser.

## Controls

- Native mouse (default): captured look; WASD: walk; Space: jump or swim up.
- Ctrl or double-tap W: sprint; Shift: sneak, including protection at supported ledges.
- Double-tap Space: toggle Creative flight; Space: ascend; Shift: descend; Ctrl: faster flight.
- Left mouse: hold to mine, click to attack. Right mouse: place/interact or hold to eat, draw a bow, or raise a shield.
- Release right mouse to fire a drawn bow; tapping does not fire. Sneak-use with a block bypasses a container's screen.
- 1–9 or mouse wheel: select a hotbar slot; middle mouse: pick a block (owned items only in Survival).
- E: inventory; Escape: close a screen or pause/resume; F: swap hands; Q: drop one item; Ctrl-Q: drop one selected stack.
- F1: hide the HUD/hands; F3: debug information; F5: first-person/back/front view.
- B opens the biome atlas and P saves: these are Voxelcraft extensions.
- Arrow keys also look around.

### Local or remote mouse input

Open **Options → Controls** on the title/pause menu:

- **Native (captured)** is the default for local mice and fresh browser profiles.
  It prefers raw/unadjusted pointer lock and retries ordinary capture when raw
  input is unsupported. Large legitimate flicks are preserved, not filtered.
- **Remote (drag look)** never captures the mouse. Use it explicitly for remote
  desktops/VNC that send absolute cursor positions: **hold the right button and
  drag to look**. A **short right-click** places/uses the held item. **Left-click
  or hold** still mines, including while right-dragging. **Hold V** for eating,
  drawing/releasing a bow, or blocking while using Remote look.
- Remote's cursor is finite: **release, reposition, and drag again at window
  edges**. The center crosshair, not the cursor, aims actions. The canvas's grab
  cursor and hotbar hints distinguish this mode. E/Escape still open inventory
  and pause; interrupted gestures do not resume when those panels close.

Remote recognizes a drag after 4 CSS pixels of travel, then includes its buffered
starting displacement. A tap must last at most 300 ms and remain below that
threshold; dragging out and back or holding to look never places on release.
Blur, pointer cancellation, resizing, disabling input, and preference changes
clear held actions and the drag anchor. The mode is never inferred from delta
size, browser identity, or a debugging flag.

**Mouse sensitivity** is a 0.25×–3× multiplier (default 1×) for both axes and
modes. The default gain is 0.002 radians per pixel, with the ordinary vertical
pitch limit. Mouse mode/sensitivity use the separate localStorage key
`voxelcraft-controls-v1`, scoped to this browser/profile and origin. Exporting,
importing, generating, or traveling between worlds does not carry or overwrite
these device preferences. If browser storage is blocked, controls still work for
the session.

Browser shortcuts such as Ctrl-W can close a windowed tab before a game receives
them. Use the game's **Fullscreen** option for keyboard capture when supported,
or double-tap W to sprint. The browser's long-Escape escape hatch always remains
available. Browser F11 fullscreen alone does not enable the Keyboard Lock API.

### Fullbright biome inspection

Open **Options → Video → Fullbright inspection** to illuminate every face for
examining underground biomes. It is off by default; the **FULLBRIGHT** HUD badge
identifies an active preview. Switch it off to immediately restore natural
darkness, torches, and the current graphics-quality shadow settings.

This is a visual override: it does not change terrain, inventory, placed lights,
world time, simulation, or draw distance. The choice stays in this browser under
`voxelcraft-view-v1`, across reloads and world changes, and is never exported in
a world save.

GUI scale also stays in this browser. The classic HUD keeps routine coordinates
behind F3; it shows actual health, hunger, equipped armor, air, XP and offhand
state rather than decorative meters.

### Compact FPS indicator

Enable **Options → Video Settings → Show FPS** for a small top-left counter.
It is off by default and stays in this browser, not in exported worlds. F1 hides
it with the HUD; F3 replaces it with the full debug display.

FPS uses rendered frame count divided by actual elapsed frame time, sampled
over roughly half a second. Visible stalls count fully; hidden/loading gaps
reset the sample. It does not use the capped physics timestep. Sampling has
constant storage/work, and the compact display changes text only when its
rounded sample changes; disabled samples never write its DOM text.

`npm run test:fps` checks real toggles, persistence and bounded
display writes against a separately frozen realtime host supplied through
`VOXELCRAFT_TEST_URL`. It also reports matched off/on/off frame-time windows.
Those timings are descriptive, especially on software WebGL; they are not an
absolute performance guarantee.
Set `VOXELCRAFT_FPS_PIXEL_RATIO=0.5` for a test-only fixed-resolution comparison;
the warmed off/on/off windows verify the requested drawing-buffer dimensions.
Omit it to observe normal adaptive resolution. Later import/reload checks are
behavior verification, not part of that fixed-resolution comparison.

## Seeded worlds and biomes

Worlds stream 16×16×96 chunks around the player, generated in a Web Worker.
Distant chunks unload while edits remain persistent. Horizontal coordinates
extend to ±30 million; there is no longer a small valley boundary. Graphics
quality controls the nearby chunk radius and shader/shadow budget.
Drawing-buffer resolution adapts gradually to sustained frame load, within the
selected quality cap. This does not change view distance, entity limits, input
handling, or the simulation clock.
Software renderers start with a conservative pixel budget; measured frame times
then guide resolution changes with warmup, cooldown, and hysteresis.
Lightweight, seed-derived distant terrain extends the horizon without keeping
full-detail chunks loaded. Performance/Balanced/Beautiful extend the coarse
horizon to 160/256/320 blocks. Far canopies share the native tree descriptors,
including their species and silhouettes. Nearby voxels, edits, and collision
remain authoritative; distant scenery is a visual approximation only.
The fallback stays drawn while individual detail chunks finish, and a hidden
row of existing meshes is retained for direction reversals. Flying altitude
is accounted for in fog instead of hiding the ground when a row rebuilds.

The catalog covers 66 Java 26.2 biome IDs: 55 Overworld entries, five Nether
biomes, and five End biomes plus the special Void. Their terrain profiles change
surface blocks, landforms, vegetation, colors, and habitats. Examples include
desert dunes, layered badlands, savanna acacias, bamboo jungles, mangrove roots,
cherry groves, Pale Garden, giant mushrooms, ice spikes, coral oceans, snowy
peaks, lush/dripstone/deep-dark/sulfur caves, crimson/warped forests, and End islands.
Sulfur Caves includes sulfur/cinnabar strata, mineral spikes, and green pools.

Generation is original and deterministic, not a reimplementation of Mojang's
seed algorithm: the same seed does not produce the same terrain as Minecraft.
Trees and features are generated in global coordinates to preserve chunk seams.
Atlas destinations are located in the actual generated world, not special
biome-display scenes.

New worlds use generator v3: broad uplands, connected ridgelines, eroded valleys,
river floodplains, terraced mesas, and patchy woodland vary within each biome.
Individual trees have seeded ages, heights, asymmetric branches, and multi-lobed
crowns; old-growth trees, birches, conifers, acacias, and jungle trees retain
different silhouettes. Open hillside entrances and occasional ravines descend
into the underground cave system with supported, player-sized routes.
Caverns and winding passages have independent floor and roof relief, with
intervening rock masses. Entrances excavate a route through existing rock rather
than filling a ramp through cave air. Lush caves have patchy moss and short,
ceiling-rooted vines with luminous berry tips.
Spawn is selected from the natural seeded landscape instead of stamping the
same starter valley into every seed. Nether and End retain their existing
generation.

Existing v1/v2 saves keep their exact terrain, including unvisited chunks and
edited buildings. The streaming improvements apply to those worlds too.
To explore the new landforms, **export your current save**, then use **Generate**
to start a new world (the same seed is allowed). There is no automatic
terrain migration or silent replacement of your active save.

## Survival and creatures

New worlds default to Survival; switch to Creative in World settings.

- Gather logs, craft planks/sticks/a table, make a wooden pickaxe, then progress
  through stone, iron, and diamond tools. Tool tiers determine ore drops;
  durability and stack/backpack limits apply.
- E opens personal 2×2 crafting. Right-click a crafting table for 3×3 recipes;
  simply standing near one does not unlock its grid. The recipe book fills real
  inputs, and taking the result consumes them.
- Every placed furnace owns input, fuel, output, burn and cooking state. It
  continues while its screen is closed, stops cooking when output is blocked
  (already burning fuel still runs down), and
  preserves its contents across reloads. Inventory does not pause the world.
- Health, hunger, saturation, air, drowning, lava, falling, food, armor, and
  regeneration are simulated. Respawning retains inventory for a forgiving
  sandbox experience.
- Passive/neutral animals include sheep, pigs, cows, chickens, horses, rabbits,
  wolves, foxes, goats, polar bears, pandas, camels, frogs, mooshrooms, cod, and
  squid, with block-absorbing sulfur cubes in Sulfur Caves. Hostiles include
  zombies, skeletons, creepers, spiders, endermen,
  slimes, husks, strays, piglins, and ghasts.
- Mobs follow habitat and day/night rules, navigate loaded terrain, react to
  attacks, and drop collectible items. Hostiles attack in Survival; creepers
  explode, skeletons use ranged attacks, and susceptible mobs burn in sunlight.
- Chests hold transferable items; Shift-click transfers a whole stack. Plant
  seeds on grass/dirt/farmland and wait for wheat. Water accelerates growth.
- Iron armor works only when equipped. Offhand torches, food and shields are
  usable; shields need a held raise and protect against frontal attacks.
- Eligible ore harvests, player kills and furnace output produce collectible XP,
  independent of inventory space.
- Bows consume arrows. TNT can be ignited. Obsidian portal frames can be lit
  with flint and steel for dimension travel. Buckets collect/place water;
  water meeting lava creates obsidian.
- Ender pearls dropped by endermen can be thrown from either hand with use
  (right-click, or V in Remote mode). Each throw spends one pearl and shares a
  one-second cooldown. A fitting solid impact teleports the player and costs
  five health in Survival, bypassing armor and shields. Flight survives pause,
  save and reload; death, respawn and travel cancel it. Blocked impacts and
  unloaded terrain that stays unavailable for two seconds consume the throw
  without teleporting; cross-dimension/stasis-ticket behavior is not implemented.

Blocks use original 16×16 pixel art, with fine stone/moss grain and distinct
mineral deposits embedded in the same surrounding stone. Creatures have pixel
skins, inset faces, varied anatomy, and ground-contact walking/hopping
animations. Slimes have a translucent shell around an opaque core; luminous
eyes stay visible in darkness without lighting the whole creature.
Artwork updates apply to existing saves without regenerating terrain or
migrating creature state.

This is not full Minecraft parity: no multiplayer, redstone automation,
villages/structure loot, boss progression, breeding/riding, or full fluid-flow
simulation. The terrain height, creature AI, recipes, portals, and survival
rules are simplified. No Mojang artwork, code, or audio is included.

### Moving inventory stacks

The owned inventory has 36 stable slots, including nine hotbar slots. Left-click
takes/places/merges/swaps; right-click takes half or places one. Shift-click moves
the clicked stack. Hover a slot and use 1–9, F, Q or Ctrl-Q for hotbar/offhand/drop
actions. Double-click gathers matching items and dragging distributes a held
stack. Each tool keeps its own wear.

Cursor and crafting-grid items remain owned during autosave. Closing a screen
returns them to inventory or safely retained world drops; refusal leaves the
screen/state intact. Old aggregate saves migrate without duplicating shortcuts,
losing worn tools or charging prepaid smelting jobs again. Old Creative palettes
remain separate from finite owned supplies; explicit catalog-copy and F/Q actions
can create Creative items, but loading, mode changes and ordinary placement do not.

## Browser saves and backups

IndexedDB stores player/inventory state and only edited chunks; untouched
terrain is regenerated from the seed and versioned generator. Writes are
asynchronous and atomic, with periodic autosaves and explicit P/Save controls.
Menus show archive status. Dropped items, overflow loot, XP orbs, chest/furnace
slots, crops, mob state, and dimension-scoped explosive fuses are included. Use Options → World →
Export/Import to move a world between browsers
or keep a backup (256 MiB encoded archive limit).

Original localStorage saves migrate with their original generator in the old
valley, with new terrain beyond it. The old localStorage entry is kept untouched
as a recovery copy. Generate a new world for the new terrain throughout.

Generating/importing replaces the single active world after confirmation;
export first to keep others. Browser storage is origin-specific and can be
cleared or evicted. Persistent-storage requests are best-effort, not a backup.
If storage is blocked or full, the game remains playable and offers file export.
Stale browser tabs cannot overwrite a newer save: export that tab's progress,
then reload to adopt the current archive. World generation, imports, and travel
are serialized so competing requests cannot dispose each other's terrain.
If a saved cave position becomes obstructed, loading first finds nearby
underground footing and preserves the saved view direction.

## Verification

`npm test` uses Node's test runner for biome generation/locators/seams, streaming
and eviction, stale-worker replies, legacy migration, IndexedDB roundtrips,
collision/raycasting, resource conservation, crafting, tools, mobs, pickups,
containers, crops, renderer geometry, Remote drag/tap/button/lifecycle integration,
native capture/flicks, and browser preference validation. IndexedDB tests use `fake-indexeddb`.
`npm run build` verifies the production bundle and terrain worker.

`npm run test:terrain` checks the real import/reload/Generate UI in an isolated
browser: old terrain and edits stay unchanged, and only confirmed generation
opts the same seed into v3.
`npm run test:native-v4` checks the actual v4 module worker,
synchronous fallback, transferred planes and declarations on an explicitly
supplied fresh `VOXELCRAFT_TEST_URL`. Its `test/native-v4-worker.html` entry is
included in `npm run build:realtime`, which sets production mode.
The check rejects source/HMR pages and protected gameplay ports. It does not
change the new-world default or demonstrate Survival reachability/performance.
`npm run test:pearls` uses a separate frozen realtime host to
verify trusted use input, swept impact, finite pearl/health costs, physical aim,
GPU projectile resources/pixels, real save/reload and lifecycle cleanup. Set
`VOXELCRAFT_TEST_URL` to a fresh isolated origin; optional
`VOXELCRAFT_PEARLS_BUILD_LABEL` pins its compiled label. Supplies and small
collision fixtures are explicitly authored; this is not a natural-acquisition
or performance benchmark.
`npm run test:inspection` checks Fullbright in six real cave views, natural
lighting restoration, unchanged world state, and browser-only persistence.
`npm run test:ui` exercises the classic menus and real slot/container actions in a
fresh disposable browser profile.
With the local Vite dev server running, `npm run test:art` renders representative
textured creatures through real WebGL at every quality, with natural and
Fullbright lighting. It checks shader errors, model picking, and shared
GPU-resource bounds. A separate pixel-accurate GPU probe covers all species,
six-face UV orientation, eye emission, damage/fuse tinting, and GPU disposal.
These isolated authored fixtures are rendering regression tests, not
visual-quality, AI, or performance evidence.

Browser verification should cover biome travel across the former boundary and
all dimensions, gathering/crafting/smelting, fighting/eating, container transfer,
planting, save/reload, export/import, and input/pointer-lock state transitions.

With the local Vite server running, `npm run test:controls`
(or `npm run test:controls` from this directory)
runs an isolated Chrome profile against the real UI. It checks Native capture and
a 400px flick, Remote 2px drags and both-axis reversals, simultaneous mining/look,
E/Escape, sensitivity, reload, import isolation, and return to Native. It uses the
test-only realtime entrypoint, not production debug flags or the temporary camera
probe. `CHROME_BIN` and `VOXELCRAFT_TEST_URL` can select Chrome and the local
server. CDP input is not OS/VNC input: repeat an actual absolute-cursor right-drag
on the affected remote desktop before claiming that transport is verified.

The application API is `game.setControlPreferences({ inputMode: "remote",
mouseSensitivity: 1 })`; `game.controlPreferences` holds the normalized settings.
`player.inputMode` and `player.mouseSensitivity` are runtime-only accessors.
`player.lock()` returns readiness in Remote without requesting capture, while
`player.locked` always reports the actual browser lock. UI selectors are
`#input-mode-setting`, `#mouse-sensitivity-setting`, `#mouse-sensitivity-value`,
`#input-mode-help`, `.hotbar-look-hint`, and `.hotbar-edge-hint`. The canvas exposes
`data-input-mode` and `data-looking` for its normal cursor styling.

### Real-time control and performance bot

Install Chrome (or set `CHROME_BIN`) and run the bot against a frozen production
benchmark build, so source edits cannot interrupt a measured run:

```bash
npm run build:realtime
npm run preview:realtime
```

In another terminal:

```bash
VOXELCRAFT_TEST_URL=http://127.0.0.1:5175 npm run test:realtime -- --quality low --width 1920 --height 1080
```

The bot uses native, trusted browser keyboard and pointer-lock mouse events at
real-time cadence, without model round trips. It traverses generated terrain,
crosses chunk boundaries, checks menus and stuck keys, and tests Survival jumping,
collision, and timed mining in a separately labeled control fixture. Its isolated
browser profile never shares the player's saves.
An additional natural-tree scenario gathers logs, crafts and places a workbench,
makes and wears a pickaxe, then verifies the real save/reload path; its unmeasured
starting pose is reported separately from the continuous traversal.

JSON reports contain frame-time percentiles, jank, input-to-camera/movement-update
latency (not input-to-photon latency), CPU phase timings, world-clock rate, input
counts, and chunk-cache bounds. `--pixel-ratio` is an explicit diagnostic override,
not a production performance result. See `test/realtime/config.mjs` for optional
performance budgets. The normal `npm test` remains a fast, browser-free suite.

### Continuous flight coverage

Against the same frozen benchmark host:

```bash
VOXELCRAFT_TEST_URL=http://127.0.0.1:5175 npm run test:streaming -- --quality medium --duration 55
```

This separate bot holds real movement keys through chunk boundaries and
reversals at feet heights 64, 104, and 152. It samples actual indexed ground
geometry and the camera's fog visibility, not just loaded/ready flags.
Coverage loss fails by default. Its ray-casting observer is measured and
included in frame timings; use `test:realtime` for ordinary play performance.
`VOXELCRAFT_FLIGHT_ALTITUDES=152` isolates high flight.
`VOXELCRAFT_STREAMING_TRANSITIONS=1` adds separately labeled public-API quality,
teleport, and dimension transitions followed by native flight.
`VOXELCRAFT_STREAMING_DIAGNOSTIC=1` explicitly allows a failing coverage
baseline; empty/invalid runs and failed transitions still fail.
The dedicated test entrypoint contains the observer, not the production game.

The package is intentionally standalone and uses its own npm lockfile, outside
the monorepo pnpm workspace.
