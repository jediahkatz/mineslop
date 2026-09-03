# Ore art review checkpoint

The 19 ore IDs have source-specific paired visual passes at the
[refinement checkpoint](https://github.com/jediahkatz/mineslop/commit/8f8f6b469f229a4aa41e9a81eb991f1af9cddec5).
This does not approve the final combined game. Their entries in
`block-art-review.md` remain `blocked` until final-source evidence and
live-world checks are complete; the other 251 catalog IDs remain unreviewed.

Reviewed source fingerprint:
`4cd82d336c03a0656fce8d1dfb2fe47bcf81852775c44b2006abc2c54cf1262e`.

## Verification performed

- 54 focused pixel, material, dispatch, host-preservation and atlas checks pass.
- Both browser suites pass, including actual rendering of all 270 catalog IDs.
  Runtime coverage is separate from visual approval.
- All 95 required ore views were captured: blind daylight; labeled daylight,
  shadow and night; and the declared repeated state, across 20 sheets.
- Independent initial guesses were preserved before labels were revealed.
  Native-scale detail views resolved overview-resolution gaps; a second
  independent reviewer assessed each material without earlier judgments.
- Controlled comparisons added six sheets, 27 native cards, exact 32px/64px
  icon crops and two unscaled 32px-only strips. Original images, receipts,
  crop coordinates, decoded pixels and hashes were preserved.

## Per-ID results

These describe the supplied source-specific views, not final manifest approvals.

- 14 Coal ore: neutral black fragments remain distinct against the light host.
- 62 Iron ore: unchanged beige chips remain distinguishable from yellow gold.
- 63 Gold ore: unequal mineral pockets replace the more stud-like construction.
- 64 Diamond ore: irregular cyan fragments retain recognizable small-scale contrast.
- 65 Copper ore: orange exposures and localized oxidation retain distinct cues.
- 66 Redstone ore: red-dominant fragments replace the repeated rusty-hook motif.
- 67 Emerald ore: varied green fragments avoid the earlier upright-button cadence.
- 68 Lapis ore: unchanged blue fragments retain their material identity.
- 1060 Deepslate coal: direct comparison resolves the small-icon evidence gap.
- 1061 Deepslate iron: pale fragments retain their dark-host relationship.
- 1062 Deepslate copper: orange-led identity survives reduced green detail at 32px.
- 1063 Deepslate gold: yellow/ochre pockets remain clear on the dark substrate.
- 1064 Deepslate redstone: both reviewers pass all seven native-view criteria.
- 1065 Deepslate diamond: cyan/dark separation survives icon and held presentation.
- 1066 Deepslate lapis: blue remains distinguishable despite expected low-light loss of host detail.
- 1067 Deepslate emerald: green mineral structure remains readable at the supplied scales.
- 1068 Nether gold: red-host/yellow-deposit identity remains distinctive.
- 1069 Nether quartz: unchanged cream crystals retain their red-host contrast.
- 1070 Ancient debris: comparison with actual soil/wood assets resolves the identity concern.

## Controlled comparison findings

Unassisted 32px judgments remain unchanged. Reviewers initially described
deepslate coal broadly as ore-speckled/pitted rock, and ancient debris as
coarse rubble. Those descriptions are not retroactively changed into exact
fantasy-material guesses.

For 1060, the relevant question was collision with actual plain dark stone:
the native icon has discrete black inclusions, unlike comparatively uniform
deepslate or blackstone's coarser purple-charcoal patches. Ordinary coal shares
the mineral pattern on a lighter host. The original reviewer closed the
inventory discrimination gap after this controlled comparison.

For 1070, coarse contrasting fragments and short broken bands differ from
soul sand's finer pitting, dirt's warmer broad patches, spruce's directional
bark/end grain and netherrack's red cast. The original reviewer closed both
identity and held/inventory concerns, including matched shadow views.
Exact unaided naming remains less immediate than learning to distinguish
the asset; no art was changed merely to obtain a favorable second verdict.

## Evidence and remaining gates

Cloud verification evidence is retained under these VM-local paths; it must
be attached or reacquired for off-VM verification:

- `/opt/cursor/artifacts/mineslop_block_review_round2/`
- `/opt/cursor/artifacts/mineslop_ore_confusables_01/`
- `/tmp/mineslop-art-review-round2/` — preserved initial judgments and paired results.
- `/tmp/mineslop-ore-comparisons/` — comparison order, answer key and preserved 32px judgments.

These are neutral authored production-component fixtures, not Survival
acquisition, performance, biome-tint, motion or final cave-gameplay evidence.
No opacity, default-emission, face-assignment or world-lighting change was
inferred from expected nighttime darkness.

Before final approval, rebuild and capture against the final combined-source
fingerprint, complete live-world checks, and populate individual current
decision records in `test/block-art-review/reviews.json`. The manifest and
`check:block-art-review` must continue to report incomplete until those gates
and the remaining catalog reviews are satisfied.
