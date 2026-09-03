import {
  dataRecord,
  equipmentMode,
  equipmentProfile,
  immutable,
  integer,
  isEnchantmentCarrier,
  matchesRepairIngredient,
  randomUnit,
  refusal,
  spendExperienceLevels,
  synchronous,
  withEnchantmentData,
} from "./enchantment-domain.js";
import {
  enchantmentsCompatible,
  getEnchantmentRule,
} from "./enchantment-rules.js";
import { prepareEquipmentStationTransaction } from "./equipment-station-transactions.js";
import { isValidExperience } from "./experience.js";
import { normalizeStack } from "./inventory-slots.js";
import {
  getEnchantment,
  MAX_REPAIR_COST,
  normalizeEnchantments,
} from "./item-stack-data.js";
import { getItem } from "./items.js";

export const ANVIL_RECORD_VERSION = 1;
export const SURVIVAL_ANVIL_LIMIT = 40;
export const ANVIL_USE_DAMAGE_CHANCE = 0.12;

/**
 * Persist real left/right escrow. The displayed result and rename text are
 * transient: never serialize them as a third owned stack. Taking the result
 * atomically clears left, consumes right (or only the required repair units),
 * installs output at the caller's destination and charges XP. Closing retains
 * escrow or returns it atomically; a failed close must not delete either input.
 */
export function normalizeAnvilRecord(value, context) {
  dataRecord(value, ["version", "left", "right"], "anvil escrow");
  if (value.version !== ANVIL_RECORD_VERSION)
    throw new RangeError("Unsupported anvil escrow version");
  return immutable({
    version: ANVIL_RECORD_VERSION,
    left: value.left === null ? null : normalizeStack(value.left, context),
    right: value.right === null ? null : normalizeStack(value.right, context),
  });
}

export const createAnvilRecord = () =>
  normalizeAnvilRecord({
    version: ANVIL_RECORD_VERSION,
    left: null,
    right: null,
  });

/**
 * Pure canonical level/cost calculation, not an item producer.
 * Java charges the resulting level even for a lower/equal-max sacrifice.
 * Ineligible book enchantments are ignored; conflicts cost one level each.
 * A partial combination is legal only if something compatible is accepted.
 * Unsupported effects may remain on the left, but cannot be newly transferred.
 */
export function combineAnvilEnchantments(
  targetId,
  target,
  sacrifice,
  { fromBook = false } = {}
) {
  try {
    if (typeof fromBook !== "boolean")
      return refusal("invalid_enchantment_source");
    const item = getItem(targetId);
    if (!item) return refusal("unregistered_target");
    const merged = normalizeEnchantments(target);
    const incoming = normalizeEnchantments(sacrifice);
    if (
      !isEnchantmentCarrier(item) &&
      Object.keys(merged).some((name) => !getEnchantment(name).eligible(item))
    )
      return refusal("ineligible_target_enchantments");
    const applied = [];
    const skipped = [];
    let enchantmentCost = 0;
    let conflictCost = 0;
    for (const [name, incomingLevel] of Object.entries(incoming)) {
      const definition = getEnchantment(name);
      if (!isEnchantmentCarrier(item) && !definition.eligible(item)) {
        skipped.push({ name, reason: "ineligible" });
        continue;
      }
      const conflicts = Object.keys(merged).filter(
        (other) => !enchantmentsCompatible(name, other)
      );
      if (conflicts.length) {
        conflictCost += conflicts.length;
        skipped.push({ name, reason: "conflict", conflicts });
        continue;
      }
      const rule = getEnchantmentRule(name);
      if (!rule)
        return refusal("unsupported_enchantment", { enchantment: name });
      const previous = merged[name] ?? 0;
      const level = Math.min(
        definition.maxLevel,
        previous === incomingLevel
          ? previous + 1
          : Math.max(previous, incomingLevel)
      );
      const cost = level * (fromBook ? rule.anvilBookCost : rule.anvilItemCost);
      merged[name] = level;
      enchantmentCost += cost;
      applied.push({ name, previous, level, cost });
    }
    if (Object.keys(incoming).length && !applied.length)
      return refusal("no_compatible_enchantments", { skipped });
    return immutable({
      ok: true,
      enchantments: normalizeEnchantments(merged),
      applied,
      skipped,
      enchantmentCost,
      conflictCost,
      levelCost: enchantmentCost + conflictCost,
    });
  } catch {
    return refusal("invalid_enchantments");
  }
}

/**
 * Pure result/cost preview, independent of available XP. All item IDs stay the
 * same as the left input. Empty/whitespace rename clears a custom name; undefined
 * leaves it unchanged. Names are literal canonical text (50 Unicode characters),
 * never HTML or inferred localized display names.
 *
 * https://minecraft.wiki/w/Anvil_mechanics
 */
export function previewAnvil({
  record,
  rename,
  mode = "survival",
  bindings = {},
  context,
}) {
  try {
    equipmentMode(mode);
    const before = normalizeAnvilRecord(record, context);
    const { left, right } = before;
    if (left === null) return refusal("missing_target");
    if (rename !== undefined && typeof rename !== "string")
      return refusal("invalid_name");
    const item = getItem(left.id);
    if (isEnchantmentCarrier(item) && left.count !== 1)
      return refusal("target_count");
    let durability = left.durability;
    let rightConsumed = 0;
    let repairCost = 0;
    let enchantmentCost = 0;
    let conflictCost = 0;
    let enchantments = left.data?.enchantments ?? {};
    let applied = [];
    let skipped = [];
    let repaired = 0;
    let operation = "rename";

    if (right !== null) {
      const source = getItem(right.id);
      const fromBook = isEnchantmentCarrier(source);
      const profile = equipmentProfile(left.id, bindings);
      const materialRepair =
        Boolean(item.durability) &&
        matchesRepairIngredient(
          right,
          profile.repairIngredients,
          bindings,
          context
        );
      if (materialRepair) {
        const repairPerUnit = Math.floor(item.durability / 4);
        const missing = item.durability - durability;
        if (repairPerUnit <= 0 || missing <= 0)
          return refusal("no_repair_needed");
        rightConsumed = Math.min(
          right.count,
          Math.ceil(missing / repairPerUnit)
        );
        repaired = Math.min(missing, rightConsumed * repairPerUnit);
        durability += repaired;
        repairCost = rightConsumed;
        operation = "material_repair";
      } else {
        const sameDurable = Boolean(item.durability) && right.id === left.id;
        if (
          (!sameDurable &&
            !(fromBook && (item.durability || isEnchantmentCarrier(item)))) ||
          right.count !== 1
        )
          return refusal("incompatible_sacrifice");
        const incoming = right.data?.enchantments ?? {};
        if (fromBook && !Object.keys(incoming).length)
          return refusal("empty_enchanted_book");
        rightConsumed = 1;
        operation = fromBook ? "book_combination" : "item_combination";
        if (sameDurable) {
          const combined = Math.min(
            item.durability,
            durability +
              right.durability +
              Math.floor((item.durability * 12) / 100)
          );
          repaired = combined - durability;
          durability = combined;
          if (repaired) repairCost = 2;
        }
        const combination = combineAnvilEnchantments(
          left.id,
          enchantments,
          incoming,
          { fromBook }
        );
        if (!combination.ok) return combination;
        ({ enchantments, enchantmentCost, conflictCost, applied, skipped } =
          combination);
      }
    }

    const changes = { enchantments };
    let renameCost = 0;
    if (rename !== undefined) {
      const name = rename.trim().length ? rename : undefined;
      if (name !== left.data?.name) {
        changes.name = name;
        renameCost = 1;
      }
    }
    const workCost = repairCost + enchantmentCost + conflictCost;
    if (!workCost && !renameCost) return refusal("no_change");
    const renameOnly = workCost === 0 && renameCost > 0;
    const leftPenalty = left.data?.repairCost ?? 0;
    const rightPenalty = right?.data?.repairCost ?? 0;
    const priorWork = leftPenalty + rightPenalty;
    let levelCost = Math.min(
      MAX_REPAIR_COST,
      priorWork + workCost + renameCost
    );
    if (renameOnly) levelCost = Math.min(39, levelCost);
    if (mode !== "creative" && levelCost >= SURVIVAL_ANVIL_LIMIT)
      return refusal("too_expensive", { levelCost });
    const largestPenalty = Math.max(leftPenalty, rightPenalty);
    changes.repairCost = renameOnly
      ? largestPenalty
      : Math.min(MAX_REPAIR_COST, largestPenalty * 2 + 1);
    const output = withEnchantmentData(
      { ...left, ...(durability === undefined ? {} : { durability }) },
      changes,
      { context }
    );
    const remainingRight =
      !right || rightConsumed === right.count
        ? null
        : { ...right, count: right.count - rightConsumed };
    const after = normalizeAnvilRecord(
      {
        version: ANVIL_RECORD_VERSION,
        left: null,
        right: remainingRight,
      },
      context
    );
    return immutable({
      ok: true,
      before: { record: before },
      after: { record: after },
      output,
      operation,
      repaired,
      rightConsumed,
      renameOnly,
      applied,
      skipped,
      levelCost,
      costs: {
        priorWork,
        repair: repairCost,
        enchantments: enchantmentCost,
        conflicts: conflictCost,
        rename: renameCost,
      },
      key: JSON.stringify([
        1,
        before,
        rename === undefined ? ["keep"] : ["set", rename],
        mode,
        output,
        levelCost,
      ]),
    });
  } catch {
    return refusal("invalid_anvil_input");
  }
}

/** Add affordability and a stale-preview check without mutating either input. */
export function planAnvil({
  record,
  rename,
  previewKey,
  experienceTotal,
  mode = "survival",
  bindings = {},
  context,
}) {
  if (!isValidExperience(experienceTotal)) return refusal("invalid_experience");
  const preview = previewAnvil({ record, rename, mode, bindings, context });
  if (!preview.ok) return preview;
  if (typeof previewKey !== "string" || previewKey !== preview.key)
    return refusal("stale_preview");
  const chargedLevels = mode === "creative" ? 0 : preview.levelCost;
  const experienceAfter = spendExperienceLevels(experienceTotal, chargedLevels);
  if (experienceAfter === null)
    return refusal("insufficient_levels", { levelCost: preview.levelCost });
  return immutable({
    ...preview,
    chargedLevels,
    experienceBefore: experienceTotal,
    experienceAfter,
  });
}

/**
 * Caller supplies a draft-only receiveOutput and prepared escrow participant.
 * Capacity, XP, input consumption and prior-work publication commit together.
 * A World participant for anvil wear/removal can be included in participants;
 * this module neither allocates anvil block IDs nor owns world mutations.
 */
export function prepareAnvilTransaction({
  gameplay,
  record,
  rename,
  previewKey,
  bindings,
  prepareStation,
  validateAccess,
  receiveOutput,
  participants = [],
  context = gameplay?.context,
}) {
  if (!synchronous(receiveOutput)) return refusal("missing_output_destination");
  return prepareEquipmentStationTransaction({
    gameplay,
    prepareStation,
    validateAccess,
    receiveOutput,
    participants,
    preview: (experienceTotal, mode) =>
      planAnvil({
        record,
        rename,
        previewKey,
        experienceTotal,
        mode,
        bindings,
        context,
      }),
  });
}

/** Optional World/RNG hook: stages 0/1/2, null means the final stage broke. */
export function anvilWear(stage, roll) {
  integer(stage, "anvil wear stage", 0, 2);
  randomUnit(roll);
  const damaged = roll < ANVIL_USE_DAMAGE_CHANCE;
  const broken = damaged && stage === 2;
  return immutable({
    stage: broken ? null : stage + Number(damaged),
    damaged,
    broken,
  });
}
