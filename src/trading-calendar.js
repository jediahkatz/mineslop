export const JAVA_DAY_TICKS = 24000;
export const MAX_WORLD_DAY = 2_147_483_647;
export const MAX_DAILY_RESTOCKS = 2;
export const RESTOCK_WORK_START = 2000;
export const RESTOCK_WORK_END = 9000;

/** Calendar day and time-of-day ticks, NOT elapsed simulation seconds. */
export function normalizeTradeClock(value) {
  // Preserve the strict snapshot-record contract without importing progression
  // content: plain/null-prototype records and enumerable own data fields only.
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new RangeError("Invalid progression record");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !["day", "time"].includes(key) ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      throw new RangeError("Unknown or non-data progression field");
  }
  if (
    !Number.isSafeInteger(value.day) ||
    value.day < 0 ||
    value.day > MAX_WORLD_DAY ||
    !Number.isInteger(value.time) ||
    value.time < 0 ||
    value.time >= JAVA_DAY_TICKS
  )
    throw new RangeError("Invalid villager calendar");
  return { day: value.day, time: value.time };
}

/** Project a normalized trader's calendar; never mutate stock or simulate work. */
export function advanceTraderCalendar(record, value) {
  const clock = normalizeTradeClock(value);
  if (
    clock.day < record.clock.day ||
    (clock.day === record.clock.day && clock.time < record.clock.time)
  )
    throw new RangeError("Villager calendar cannot move backwards");
  return {
    clock,
    restocks: clock.day > record.clock.day ? 0 : record.restocks,
    lastRestockTime:
      clock.day > record.clock.day ? null : record.lastRestockTime,
  };
}
