# Native Survival boat acceptance

Boat steering uses A/D; W/S supply thrust independently of mouse look. Accepted
hull rotation carries the rider's view while preserving its relative look
offset and pitch. First mount/reload seeds that relationship without snapping;
repeated pose delivery cannot rotate the view twice.

## Finite acquisition and persistence

The native acceptance route starts with only the four Survival starter apples:

1. Walk from the actual generated spawn to a natural oak tree.
2. Mine and collect three matching logs with normal input.
3. Craft 12 planks, then one crafting table for four planks.
4. Place the table on a natural shoreline and open its actual 3×3 workbench.
5. Craft an oak boat for five planks. No shovel is required.
6. Place the owned boat in water, release the use button, then mount the hull
   with a separate use gesture.
7. Check forward/reverse motion, A/D turns, released coasting, independent
   mouse look, and safe Shift dismount.
8. Save, quit, and reload the actual browser archive both seated and dismounted.

The final ownership is one placed table, one unduplicated boat, three carried
planks and the four untouched starter apples. The test checks real dropped
items, the crafting grid and cursor, inventory, world edits, boat ownership and
IndexedDB—not just displayed totals.

## Run

Use an isolated browser profile. This game has one local world archive; do not
replace an existing personal world to run this route.

```sh
mise run --tool node@22.14.0 start
BOAT_SURVIVAL_URL=http://127.0.0.1:5173/mineslop/ \
  mise run --tool node@22.14.0 test:boats
```

The server and test must use the same frozen source checkpoint. The test checks
critical control, crafting and observer source fingerprints on every loaded
document. It creates a fresh browser context, confirms the real default
Survival initialization, and chooses `boat-survival-6` only through the normal
New World UI. It never grants inventory, edits terrain for setup, teleports,
writes player angles, forces clocks or invokes gameplay actions directly.

The current route exercises native generator v3, including compatibility with
the existing world format; it is not acceptance of the future expanded-world
default. Its bounded planner reads only admitted cells. No favorable fixture
geometry or forced chunk admission is substituted after a failed route.

The camera assertions require actual nonzero hull rotation, matching physical
and rendered-camera rotation, stable relative look/pitch and once-only
application. A frozen camera, even if it follows the seat's position, fails.

## Manual route

The generated spawn is near `(-138.5, 32.01, -97.5)`. The read-only planner
finds a tree approach near `(-138.5, 31, -81.5)` and three oak logs at
`(-141, 31–33, -82)`. A shoreline approach is near `(-146.5, 27, -80.5)`.
These are navigation observations, not permission to teleport.

Press E to use the personal crafting grid and recipe book. Extracting the
result consumes ingredients; filling a recipe does not. Place and use the
crafting table to obtain the 3×3 boat recipe. P saves; Escape → Save and Quit,
then an actual browser reload and Play World, verifies persistence. F5 changes
perspective and is not a browser reload in the game.

Automated browser acceptance and the manual GUI walkthrough are separate
evidence. A successful owner-unit test or authored ocean fixture alone does
not establish this native Survival flow.
