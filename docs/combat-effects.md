# Paid effects in live combat

Normal Game melee now consumes Sharpness, Smite, Strength and Weakness
projections from the active progression owner. Main-hand and offhand bow
shots consume Power from the bow that actually pays for the shot.

For the existing iron sword's six-point attribute, Sharpness III deals eight,
Strength I nine, and Weakness I two. Smite II deals eleven against zombies,
skeletons, husks, strays and drowned, but remains six against other families.
The existing four-point bow deals eight with Power III at full draw.

Status modifies the raw melee attribute before caller-supplied base scaling.
Enchantment bonuses follow, scaled by attack strength but not critical scaling.
Power precedes existing bow charge and rounding; melee potions do not modify
arrows. These rules do not introduce a new attack cooldown or critical-hit clock.
An arrowless bow melee attack remains a melee action, not a Power projectile.

Normal held-bow input also works while aiming at Ecology-owned residents.
Unsupported feeding intent proceeds to generic item use, while a recognized
but refused feed remains handled and cannot become an offhand bow or legacy
interaction. Existing hand/entity, mount, trader and splash priorities remain.
Drawing and cancellation cost nothing; one accepted release pays its arrow
and wear once. `test/game-owned-bow-input.integration.test.js` covers 41 input,
refusal, priority and stale-owner cases without test-only gameplay shortcuts.

## Ownership and compatibility

The projection is a read observation carried by the existing Gameplay cost
participant, not a second participant for the same owner. It captures the hand,
equipment revision, effects, progression bindings, World context and player
life. Stale or detached installed hosts refuse; standalone legacy callers
without a progression host retain raw damage. The final durability use hits
with its captured weapon, even after that payment empties the hand.

Owned attack transactions retain their victim, loot and XP peers. Refusal
does not spend their attack cost, advance the action cooldown or consume RNG;
a fresh retry pays once. Raw environmental damage never borrows the player's
offensive bonuses. No save schema, generator version or production budget
changes accompany this repair.

The legacy unowned victim path still pays and applies victim damage separately,
as before. This change does not activate `CombatRuntime`, migrate that path
to atomic victim/reward transactions, or implement friendly fire and projectile
kinematics. Bow impact remains the existing hitscan behavior.

## Regression and native evidence

`test/progression-combat-field.integration.test.js` exercises 28 actual Game
attacks after finite anvil or brewing/drinking payments. Its habitats and
starting resources are authored. The additional combat tests cover family
classification, damage ordering, both hands, final wear, stale observations,
owned lethal peer veto/retry, pause, death/respawn and dimension travel.

`test/native-combat.integration.test.js` uses the first qualifying native-v4
`cedar-valley` beach and the unchanged population scheduler in a real Game
frame. Its fixed search allows 9,409 coarse columns and eight neighbors per
beach candidate. It declares two radius-two admission footprints before
loading, within a 49-column radius-three bounding box. The selected case
generates 38 columns, retains 25 and normally evicts 13; cold reconstruction
generates 25. Interaction generates no additional terrain.

One supplied plain iron sword, one Sharpness III book, 27 XP and one supplied
anvil are explicit prerequisites. The anvil consumes the book and three levels.
A normal primary hit changes the naturally scheduled turtle's health from
30 to 22 and the sword's durability from 250 to 249, without kill rewards or
offense RNG draws. Export/parser/preflight and fresh Game/World reconstruction
preserve paid owners and clocks. Only fluid resident-scan metadata is allowed
to rebuild; fluid resource work and time are not exempt.

`test/combat-browser-save.mjs` exports an exclusively created, unpaid
starting save for manual verification on a new browser origin. It never
overwrites an existing file and does not itself perform a GUI demonstration.

The separate main-app browser check uses that supplied kit in Survival,
with Fast/R2 graphics and Fullbright off. Actual anvil input pays the book
and three levels; one keyboard-aimed primary hit produces the same 30→22 HP
and 250→249 durability changes. The original world and preferences are untouched.
Five actual exports cover the unpaid start, paid upgrade, hit, cold page reload
and normal file restoration. The restored sword's inventory tooltip shows
Sharpness III, prior repair cost one and 249/250 durability.

```sh
node --test test/game-combat-effects.integration.test.js \
  test/game-combat-effects-guards.integration.test.js \
  test/progression-combat-field.integration.test.js \
  test/native-combat.integration.test.js
node test/combat-browser-verify.mjs unpaid.json paid.json hit.json cold.json restored.json
```

The read-only backup verifier checks every saved owner and clock against the
hit checkpoint, with only the same fluid resident-scan metadata exception.
Cold and imported exports are captured before Play; later ordinary gameplay
and inventory inspection are not claimed to preserve a frozen simulation.
The verifier also has negative coverage for missing XP payment, an unexpected
offense RNG draw and an altered restored clock. File assertions complement
the GUI recording; they do not establish how arbitrary supplied files arose.

## Remaining scope

These checks do not establish resource acquisition from an empty inventory,
full Java combat parity or the complete world/item goal. Other enchantment
and potion consumers remain separate work. Existing native-retention,
Game-frame-budget and renderer failures retain their recorded status; this
bounded native interaction does not qualify sustained rendering or performance.
