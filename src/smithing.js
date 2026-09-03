import { dataRecord, immutable, refusal } from "./enchantment-domain.js";
import { getArmorSpec, getToolSpec } from "./gear.js";
import { cloneStack, normalizeStack } from "./inventory-slots.js";
import { getItem, ITEMS } from "./items.js";

export const SMITHING_RECORD_VERSION = 1;

export function normalizeSmithingRecord(value, context) {
  dataRecord(value, ["version", "template", "base", "addition"], "smithing escrow");
  if (value.version !== SMITHING_RECORD_VERSION)
    throw new RangeError("Unsupported smithing escrow");
  return immutable({
    version: SMITHING_RECORD_VERSION,
    template: value.template === null ? null : normalizeStack(value.template, context),
    base: value.base === null ? null : normalizeStack(value.base, context),
    addition: value.addition === null ? null : normalizeStack(value.addition, context),
  });
}

export const createSmithingRecord = () => normalizeSmithingRecord({
  version: SMITHING_RECORD_VERSION, template: null, base: null, addition: null,
});

/** No ID allocation, grid recipe, name inference or free equipment upgrade. */
export function smithingOutputItem(base) {
  const item = getItem(base?.id);
  if (item?.gearMaterial !== "diamond" || !item.durability) return null;
  const candidate = ITEMS.find((entry) =>
    entry.gearMaterial === "netherite" &&
    (item.equipmentSlot
      ? entry.equipmentSlot === item.equipmentSlot
      : !entry.equipmentSlot && entry.tool === item.tool)
  );
  if (!candidate) return null;
  const spec = item.equipmentSlot
    ? getArmorSpec("netherite", item.equipmentSlot)
    : getToolSpec("netherite", item.tool);
  return candidate.durability === spec.durability &&
    candidate.smithingUpgrade?.baseMaterial === "diamond" ? candidate : null;
}

/**
 * One consumed template + diamond item + ingot. Preserve name, enchantments,
 * prior work AND the absolute damage component, as Java smithing does. The
 * result is a preview, not a fourth owned stack, until its destination commits.
 */
export function previewSmithing(record, context) {
  try {
    const before = normalizeSmithingRecord(record, context);
    const { template, base, addition } = before;
    const outputItem = smithingOutputItem(base);
    if (!base || base.count !== 1 || !outputItem) return refusal("invalid_smithing_base");
    const upgrade = outputItem.smithingUpgrade;
    if (
      !template || getItem(template.id)?.smithingTemplate !== "netherite_upgrade" ||
      getItem(template.id)?.resourceLocation !== upgrade.template
    )
      return refusal("missing_upgrade_template");
    if (!addition || getItem(addition.id)?.resourceLocation !== upgrade.ingredient)
      return refusal("missing_netherite_ingot");
    const damage = getItem(base.id).durability - base.durability;
    const output = normalizeStack({
      ...base, id: outputItem.id, durability: outputItem.durability - damage,
    }, context);
    const debit = (stack) => stack.count === 1 ? null :
      { ...cloneStack(stack, context), count: stack.count - 1 };
    return immutable({
      ok: true, output, levelCost: 0,
      before: { record: before },
      after: { record: normalizeSmithingRecord({
        version: SMITHING_RECORD_VERSION,
        template: debit(template), base: null, addition: debit(addition),
      }, context) },
      key: JSON.stringify([SMITHING_RECORD_VERSION, before, output]),
    });
  } catch {
    return refusal("invalid_smithing_input");
  }
}
