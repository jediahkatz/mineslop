# Loot-aware dolphin guidance

A paid dolphin feed now selects worthwhile resident wreck/ruin chests, not just
a nearby structure descriptor. Exploration supplies a synchronous read-only
observation; it does not introduce another inventory or entitlement ledger.

The observation distinguishes:

- `untouched`: an eligible native entitlement, without rolling or previewing it.
- `nonempty`: initialized Settlement slots contain actual items.
- `empty`: initialized slots have no items.
- `destroyed`: the native chest was destroyed, replaced or invalidated.
- `unknown`: an anchor is unloaded/unadmitted, or initialized ownership is missing.

A `materialized` or `cleared` claim alone says nothing about remaining items.
Partially drained chests stay useful; an empty chest can give way to another
chest in the same structure. Refilled, initialized contents also remain useful.
Known depletion of every chest clears guidance. Unknown residency suspends the
runtime target while the existing saved guide timer continues normally.

## Ownership and bounds

Feeding pins the installed Exploration/Settlement owners, revisions, exact
descriptor and marker identities, chunk incarnation, and existing physical,
hand and session guards. A stale preparation refuses without spending its fish.
Recognized feeding refusals remain handled by entity dispatch and cannot turn
into a legacy interaction or an unrelated offhand use.

Scouting never rolls loot, searches for maps, initializes containers, admits
markers, requests chunks or generates terrain. The host still supplies at most
four structures within 64 blocks. Existing AI ceilings do not enlarge that
host budget.

The saved fields remain `id`, `kind`, `position` and `remaining`. The current
chest goal is runtime-only; the saved position keeps its original structure
identity. No schema or generator change is required. Assistance and Dolphin's
Grace still work when an accepted feed finds no worthwhile known chest.

## Verification and remaining acceptance

Run the focused selection, ownership and save regressions with:

```sh
node --test --test-concurrency=1 \
  test/dolphin-guidance.test.js \
  test/game-dolphin-loot.integration.test.js
```

Native v7 `beached-map-640` coverage uses real terrain, valid dolphin admission,
Game `KeyV` input and the real owner graph. One supplied fish pays for guidance;
partial loot keeps its target, one empty chest redirects it to its sibling,
and both empty chests stop guidance despite retained `materialized` claims.
Cold reconstruction preserves the acquired map and performs no refill rolls.

Further cases cover legacy initialized contents, refilled cleared claims,
unknown residency, destroyed/replaced chests, commit-time depletion, replaced
owners, lifetime/hand/physical guards, unchanged host bounds and existing Grace.
Compatibility coverage also checks Exploration materialization, first-open,
first-break and travel ownership, plus the existing held-bow input priorities.

These are CPU input/ownership tests with supplied fish and staged player/mob
positions. They do not establish an unaided dolphin-following journey, GUI
navigation to the beached wreck, the complete boat-to-treasure loop, or renderer
and performance acceptance.
