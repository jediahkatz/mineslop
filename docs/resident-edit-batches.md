# Composable resident-owner edits

This checkpoint refactors existing Wildlife base preparations and adds an
inactive composition API. It does not activate source-aware combat, remove
direct-player authorization checks or implement legacy lethal reward quoting.

## Complete versus incomplete plans

- `wildlife.beginResidentEditBatch()` creates a bounded detached batch.
- `contributeSourceEdit()` stages existing cooldown/fuse fields; it does not
  authorize an attack.
- `contributeLegacyDamage()` supports nonlethal non-horse/non-ecology victims.
  All horses still route through Horses, whether retained or not.
- `horses.contributeHit()` and `ecologyServices.contributeHit()` return
  incomplete contribution/peer tokens, not standalone publishers.
- `finalizeResidentEditBatch(batch, { contributions, participants })` requires
  every exact contribution and peer token, then returns a complete participant
  list and ordered predicted results.

Limits are eight edits, eight actor identities and sixteen peers. A canonical
identity receives one write intent per batch; conflicting edits are not
implicitly merged. Duplicate resource-owner writers refuse rather than having
one callback silently discarded. Rejected or late contributions invalidate
the batch, including when a caller ignores the contribution's failure.

Finalization produces exactly one Wildlife participant. Publication preserves
existing array/map/entity/vector identities and increments the base revision
once. Existing standalone horse/ecology wrappers finalize a one-entry batch,
retaining their public return shapes and resource responsibilities.

The caller must commit the complete final participant list. The coordinator
cannot detect deliberate filtering after finalization; incomplete tokens do
not remove that existing whole-plan requirement.

## Runtime composition order

The data-owner integration tests exercise this order using real owners:

1. Begin a runtime batch and obtain its pure hit quote.
2. Begin the resident batch; contribute the source base action and the actual
   Horse/Ecology victim preparation.
3. Finalize the resident batch with every contribution and peer.
4. Adapt its actual finalized result/participants to the runtime owner-result
   shape, then call `acceptHit()`.
5. Finalize the runtime with the complete resident participant list and commit
   the combined list once.

The result contains one Runtime and one Wildlife participant plus all needed
domain/resource peers. Every individual peer veto preserves all owners. Tests
also cover mounted horse death, exact saddle retention, safe pending exit,
uncredited XP behavior, revision increments and replay rejection.

This demonstrates composition, not live AI/contact authorization. The future
Game bridge still supplies current canonical identities, geometry, difficulty
and source-action authority.

## Observer handling

All base-edit observers run after committed state is installed. Ordinary-only
failures retain aggregate reporting. If any observer raises a
`TransactionInvariantError`, the first original fatal error is surfaced after
the remaining observers run, preserving the type and cause existing callers
inspect. An aggregate must not hide fatal classification.

Temporary observer probes are removed. The appearance-RNG spy in the horse
test covers preparation/commit/replay, then restores before creating a new
fixture mob, which legitimately consumes appearance RNG.

## Verification

The resident suites pass all 97 checks after those corrections. Combined
runtime/resident suites pass all 148 checks, including four new real-owner
composition cases. The standalone horse/ecology/Game compatibility run has
248 passes and the same five pre-existing native-fixture failures.

The complete frozen checkpoint
`bba0829166f9bc195814db8cc2c804a41ab46359` runs 3,722 tests: 3,704 pass and
18 inherited failures remain. Baseline comparison finds no new failures and
no changed failure assertions. The production build and both Pages-path
WebGL/worker/save-reload checks pass. The runner records the exact checkpoint
and working directory for every command, and confirms tracked source is
unchanged.

Legacy lethal RNG quotes, combat authorization, live caller cutover and genuine
Survival acceptance remain gated.
