# Fortune in live mining

Fortune now affects the Game's paid mining path, not only enchantment previews
and isolated effect helpers.

- Normal and deepslate coal, iron, copper, gold, diamond, emerald and lapis use
  the ore multiplier, including its two multiplier-one outcomes.
- Redstone uses an additive bonus. Nether gold and quartz retain their actual
  registered drops and receive the ore bonus.
- Glowstone, sea lanterns and melons retain their respective 4/5/9 item caps.
- Gravel uses the level-dependent flint probabilities; Fortune III guarantees
  flint.
- Ordinary base yields are unchanged. Creative, explosions, inadequate tools,
  unrelated building blocks and Silk Touch do not receive these bonuses.

## Ownership and saves

The live adapter reserves at most two loot samples and one XP sample from the
existing saved progression-effects RNG. It does not use the enchanting-table
seed or advance `Math.random` for a Fortune-affected harvest.

The RNG, tool wear/exhaustion, World removal, retained item drops and mining XP
publish in one existing coordinator transaction. Failed destination admission,
stale hands/terrain/hosts, or a peer veto leave the pending rolls unconsumed.
Repeated preparation cannot reroll an unpaid source; repeated commit cannot
duplicate it. No new save fields, block IDs, generator changes or migrations
are introduced.

## Regression coverage

```sh
node --test test/fortune-harvest.test.js \
  test/fortune-mining.integration.test.js \
  test/fortune-native-mining.integration.test.js \
  test/game-harvest-actions.integration.test.js \
  test/game-progression-integration.test.js \
  test/enchantment-effects.test.js
```

The owner tests include real physical targeting and `VoxelGame.primary`,
finite paid anvil-book application, every transaction-peer veto, and full
archive export/import/reconstruction. Exact saved draw counts cover Nether
gold's three samples, materials without XP, and a coal XP roll of zero.
Real overflow-capacity and full production XP-pool refusals retain the ore,
tool and pending rolls across repeated attempts. Releasing capacity permits
the identical result, including when the tool has only one durability left.
The overflow boundary uses a constructor-configured one-record test archive;
the default production capacity is unchanged. Controlled inventories and
terrain are explicitly authored prerequisites.

The separate native test uses unchanged generation 4, actual safe support
surfaces, a real 4.5-block ray and normal mining. Its central-first search reads
only nine admitted columns. The selected approach declares five additional
Game-stage columns, for 14 generated columns inside the fixed radius-two,
25-column maximum. Interaction generates no further terrain. Natural coal
becomes two retained coal items, pays one tool durability, and survives
reopened IndexedDB, file export/import and a fresh Game/World reconstruction.
The supplied tool and starting cave approach do not establish acquisition
from an empty inventory.

## Remaining goal scope

This change does not close the full world/item expansion objective or its
combined browser, Survival-acquisition, travel, performance and save acceptance.
Fortune on owned crops, grass and leaf loot remains a separate live-consumer
gap. Existing rendering qualifications, native-area retention failures and
other unintegrated work retain their prior status.
