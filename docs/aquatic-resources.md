# Retained aquatic resources

Normal Game melee, bow impacts and supported environmental damage now retain
aquatic materials through the existing transaction owners.

| Resident | Base material, any supported death | Explicit player-credit reward |
| --- | --- | --- |
| Cod | One raw cod | 1–3 XP |
| Squid | 1–3 ink sacs | 1–3 XP |
| Drowned | 0–2 rotten flesh | 5 XP; 11% chance of one copper ingot |
| Dolphin | 0–1 raw cod | 1–3 XP |
| Adult turtle | 0–2 seagrass | 1–3 XP |
| Baby turtle | None | None |

Ink reaches the existing black-dye and dark-prismarine recipes. Cod can be
eaten, cooked or used by the existing dolphin interaction. Turtle scutes remain
growth rewards, not death drops. Nautilus shells remain fishing treasure:
unarmed drowned have no carried-shell trait or trident equipment. Guardian,
elder-guardian and blaze reward tables are unchanged.

## Ownership and compatibility

Cod and squid join the retained ingredient-mob adapter, alongside spiders and
ghasts. They do not gain a second Ecology sidecar or use the old eager Wildlife
drop callback. Drowned, dolphins and turtles stay in the Ecology death path.

The canonical victim, entire drop quote, physical XP and player cost commit
together. A stale owner, full retained-item sink, full XP pool or failed peer
validation refuses the kill without losing the resident or paying for the
strike. An accepted receipt cannot be replayed. Environmental damage cannot
borrow player credit, hand wear or outgoing enchantments.

The named loot rolls depend on the recorded seed, dimension, generator version,
resident identity, kind and loot-policy version. Preparation and retry never
advance motion or progression RNG. Extracting the shared roll helper preserves
all existing spider/ghast v1 quotes; a 3,584-quote fingerprint guards that contract.
No resource change requires a new save schema, terrain regeneration or migration.

Physical XP collection is a separate accepted transaction. Its existing Mending
receiver reserves six saved progression draws per collected orb, even with
unenchanted equipment. Tests distinguish that collection budget from the
zero-draw death quote and preserve it through cold saves.

## Verification

The aquatic reward and ownership suites cover both normal attack inputs,
environmental attribution, every participating owner's veto, identical retry,
real capacity exhaustion, final tool durability and cold retained/collected
state. The existing combat, ecology and ingredient-resource suites remain
compatibility checks.

`test/native-aquatic-resources.integration.test.js` uses native v4
`cedar-valley` ocean terrain and the ordinary Game population scheduler.
Its versioned fixture declares a 49-column search box, R2/25-column live
footprints, at most 100 counted generations and 32 population frames. No
residents, drops, platform blocks or loot RNG are injected. One plain iron
sword and bounded underwater starting/approach positions are explicit
prerequisites, not acquired resources.

The selected native cod has three health and the squid ten. Three real primary
strikes plus keyboard swimming collect one cod, two ink sacs and four XP,
leaving 247/250 sword durability and full player health. The run counts 35
generated columns across its admissions; interaction cannot silently load
outside the declared footprint. Reopened IndexedDB, export/import and fresh
Game reconstruction preserve every saved owner and clock. Only fluid resident
scan metadata may rebuild; fluid resource work and time remain checked.

`test/aquatic-browser-save.mjs` exclusively creates a fresh, full-health native
cod checkpoint for an isolated browser origin. It never overwrites an existing
file or a user's world. `test/aquatic-browser-verify.mjs` checks the actual
exported starting, collected and frozen restored checkpoints, including exact
inventory, retired identity, XP, wear and collection RNG. The native test also
rejects forged payment, XP, RNG and restored-clock changes.

`test/aquatic-resource.browser.integration.mjs` runs the compiled main
application in a fresh isolated browser context. Import, options, one LMB
strike, keyboard swimming, save, download, cold page reload and file restore
use normal browser input. It has no privileged test entry, Game-global access,
camera assignment, clock override or direct action calls. The HUD supplies a
bounded collection-completion signal; four actual downloaded files check
every saved owner, resource and clock, allowing only fluid residency metadata
to rebuild.

The recorded main-app run collects one raw cod and one XP, pays one sword
durability (249/250), preserves full health and edits no terrain. The same
collected state survives both cold page reload and normal UI import without
loose items or duplicate XP. Fast/R2, Fullbright off and software rendering
are explicit test settings. This is automated browser evidence with the
supplied equipment and starting approach, not manual OS input or from-zero
acquisition. The separately prepared manual walkthrough remained untouched
when the GUI-control tool was unavailable.

```sh
node --test test/aquatic-mob-rewards.test.js \
  test/aquatic-mob-resources.integration.test.js \
  test/aquatic-ecology-resources.integration.test.js \
  test/aquatic-ecology-retention.integration.test.js \
  test/native-aquatic-resources.integration.test.js
node test/aquatic-browser-save.mjs /tmp/new-aquatic-start.voxelcraft.json
node test/aquatic-browser-verify.mjs initial.json collected.json cold.json imported.json
AQUATIC_RESOURCE_URL=http://127.0.0.1:5182/mineslop/ \
  AQUATIC_RESOURCE_RECORD=1 node --test test/aquatic-resource.browser.integration.mjs
```

File checks alone do not establish how inputs or exports arose; pair browser
checkpoints with a real main-app recording. These bounded checks do not qualify
unaided exploration, the complete boat/fishing/dolphin/treasure/conduit loop,
natural turtle growth elapsed time, renderer correctness or frame pacing.
Looting, fire-cooked mob drops, carried drowned equipment and delayed kill
attribution are outside this resource slice.
