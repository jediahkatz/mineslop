# Live combat integration sequence

The pure foundations are tested, including the corrected Peaceful suppression
of mob-origin fire. They do not activate friendly fire. The next checkpoint
adds composable base-owner edits and an inactive runtime; normal Game callers
remain on their existing paths until the complete cutover gate passes.

The [inactive runtime checkpoint](combat-runtime.md) is now implemented and
passes its isolated tests and baseline comparison. The
[resident-owner batches](resident-edit-batches.md) now pass 97 focused checks;
148 combined runtime/resident checks also pass. Broader regression verification
and scoped review remain separate. Normal Game keeps its compatibility callers;
these results do not activate the new source-aware combat paths.

## Next checkpoint: independent work boundaries

### Wildlife base-edit composition

Extend the existing `_prepareResidentEdit` machinery, not a second health/pose
engine. A bounded detached batch collects source-action and borrower edits
before finalizing exactly one Wildlife participant.

- Preserve standalone horse/ecology wrappers and their current behavior.
- Add an explicit shared-batch contribution path for horse/ecology preparation.
  Contribution plans must not masquerade as independently committable complete
  actions. The final caller supplies every domain/resource participant and
  finalizes the base batch once.
- Source actions may edit existing base `attackCooldown`/`fuse`, with canonical
  identity, field and epoch guards. They do not themselves authorize attacks.
- Nonlethal legacy base damage can use this batch; legacy lethal reward/RNG
  integration remains gated until its quote contract is settled.
- Reject conflicting writes, late contributions, duplicate identities,
  capacity violations and stale records before publication. A rejected
  contribution cannot quietly leave a success-looking partial batch.
- One publication installs the precomputed base changes and advances its
  revision once. It never calls another owner or invents drops/XP.
- Preserve horse motion/death exits, saddle metadata, ecology tombstones,
  elder completion and villager jobsite ownership.

Tests use actual World/Wildlife/Horses/Ecology owners. Cover source cooldown
plus legacy/horse/ecology victim edits, exactly one Wildlife participant,
conflicts, stale movement/health/epoch, capacity vetoes, no partial publication,
replay and existing standalone compatibility.

### Inactive combat runtime

Add one transient owner, with no imports or activation in normal Game yet.
It owns bounded attack/contact/blast/clock metadata, never canonical health,
poses, inventory or a duplicate saved entity collection.

- Separate legacy and blaze shot pools: at most 12 each.
- At most 29 actor metadata records (28 active mobs and one player), four
  blast tickets, 29 captured victims per blast and eight derived-contact
  tickets. Limits are implementation budgets, not larger simulation admission.
- Shot lifetime is bounded by six admitted seconds (blaze at most three);
  queued/pending work never extends the original deadline. Blast tickets live
  at most one admitted second; derived tickets at most half a second.
- Every update receives admitted dt; zero freezes ages/credit/hurt clocks.
  Preserve the pure 0.5-second hurt and five-second credit semantics.
- Prepared launch, motion/contact, presentation acknowledgment, blast
  admission/victim advancement and cancellation combine into one runtime
  participant per transaction. Publication is installation-only.
- Runtime-issued token identity and epoch/revision guards reject copied,
  consumed and stale tickets. Opaque canonical refs are never frozen as
  entity objects or serialized.
- A launched shot retains immutable provenance after source death. Blaze
  movement/damage eligibility requires acknowledgment of a completed prior
  presentation; acknowledgment cannot resurrect expired work.
- Ghast shot retirement and blast admission occur in one runtime preparation.
  Capacity veto preserves pending work without motion/damage or deadline
  extension. A successful blast victim joins damage and cursor advancement;
  a refused/stale victim is skipped once, never retried after space frees.
- Actor-life replacement invalidates that victim, not unrelated victims;
  World/runtime replacement retires the whole stale scope.

Runtime tests prove ownership/epoch, unique participants, veto/replay, pool
budgets, acknowledgment, source-death provenance, deadlines, per-victim skips
and dt partitions. These data-owner tests do not prove live Game authorization
or damage delivery; the bridge must supply actual current canonical facts.

## Before the live owner bridge

Split attack authorization from reward eligibility in the horse/ecology
adapters. Keep direct-player reach/current-life validation intact. Every horse,
including untracked wild horses, still routes to Horses; refusal never invokes
legacy damage or hits an actor behind the refused contact.

Aggregate source/victim base edits within Wildlife, player health/wear/costs
within one Gameplay draft, and effect changes/lethal clearing within one
StatusEffects preparation. Do not concatenate duplicate owner participants
and discard one callback.

Use the existing player owner/life bridge. Full classified difficulty
adjustment precedes the hurt-window comparison; armor/effects consume only its
incremental pre-armor amount. Stable player reward ownership is not a current
player position, hand, life or attack-authorization flag.

## Decisions required before activation

- **Retry-stable legacy rewards:** Wildlife item loot consumes its saved LCG;
  legacy XP uses Gameplay's injectable, normally `Math.random`, callback.
  A quote must not consume either during preparation, overwrite newer RNG or
  reroll the same pending hit after a resource veto. Define and document any
  intentional RNG-source migration rather than silently changing it. Legacy
  lethal integration waits for this decision.
- **Burns:** preserve the existing blaze payload (four seconds) and define
  cadence, refresh/overlap provenance, extinguishing and Peaceful cancellation.
  Mob-origin fire remains suppressed in Peaceful; environmental fire remains
  distinct. Neither is difficulty-scaled.
- **Projectile size/policy:** preserve arrow speed 12/gravity 2.8/lifetime six,
  ghast speed six/lifetime six/blast radius 1.8 and blast-only impact behavior.
  Blaze already supplies speed nine/lifetime three/radius 0.15 and a
  non-explosive impact. Legacy collision radii are not inferred from model
  geometry; pin them explicitly before changing flight.
- **Nonexplosive refusals:** ratify pending-contact lifetime/retry behavior
  alongside quote invalidation. Never pass through an immune/unavailable
  foreground body or apply delayed damage after contact becomes stale.
- **AI:** brains must consume the committed actual revenge target for aiming
  and pursuit; generic player-directed anger cannot run in parallel.

## Single activation gate

Only after the owner bridge, shared blast processor, both flight replacements,
retaliation consumers and authoritative persisted difficulty pass their tests
may `GameCombatServices.activate` install the new callers together.

Keep canonical restore order: normalize all archive copies, load Wildlife once,
adopt Ecology, bind Horses/activate borrowers, reset accepted transient combat
state, then activate the runtime before simulation. Never alter canonical
saved anger/cooldown/fuse fields before adoption comparison.

The old legacy and ecology flight collections cease simulation/damage authority
at the same gate. Models remain readers. Guardian beams keep their targeted
presentation; required reflected damage becomes bounded derived work, not an
optional notification callback.

Persist one strict per-world difficulty value with runtime revision guards.
Peaceful blocks hostile admission/wake, attacks, shots, beams, harmful
creature effects and terrain damage before observers can resume work. Preserve
owned creatures/resources without granting rewards. TNT fuse/provenance
migration is explicitly deferred.

Complete real-owner, save/lifecycle, trusted-input controlled and genuine
Survival tests plus measured work/frame budgets before publication. Existing
hand or art evidence is not acceptance of this new combat behavior.
