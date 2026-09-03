import { getItem, ITEM } from "./items.js";

export const MAX_LIVING_HORSES = 8;
export const MAX_RETAINED_HORSE_IDS = 1024;
export const HORSE_RADIUS = 0.88;
export const HORSE_HEIGHT = 2.45;
export const HORSE_SEAT_HEIGHT = 0.95;
export const HORSE_RIDER_RADIUS = 0.3;
export const HORSE_RIDER_HEIGHT = 1.8;
export const HORSE_STEP_HEIGHT = 1;
export const HORSE_MAX_SPEED = 10;
export const HORSE_MAX_VERTICAL_SPEED = 32;
export const HORSE_MAX_FALL_DISTANCE = 512;
export const HORSE_GRAVITY = 20;
export const HORSE_STEP_SECONDS = 0.05;
export const HORSE_MAX_ELAPSED = 0.2;
export const HORSE_ACTIVE_DISTANCE = 58;
export const HORSE_STRIDE_DISTANCE = 1.4;
export const HORSE_JUMP_CHARGE_SECONDS = 1;
export const HORSE_TAMING_TICKS = 60;
export const HORSE_TICKS_PER_SECOND = 20;

// Authored tuning, not a claim of exact vanilla timing/speed/attribute rolls.
export const HORSE_RIDE_SPEED = 8;
export const HORSE_JUMP_MIN = 5;
export const HORSE_JUMP_MAX = 9;
export const HORSE_WADE_DEPTH = 1;
export const HORSE_SHALLOW_SPEED_FACTOR = 0.45;

// Four includes the canonical base and every permitted archive compatibility
// copy. Parent must reject additional copies, not charge moving poses each tick.
export const HORSE_BASE_COPY_LIMIT = 4;
// Includes a 100-code-unit ID at JSON's worst six bytes per escaped unit,
// full-precision finite base fields and all separators, even after motion.
export const HORSE_BASE_RECORD_RESERVED_BYTES = 2048;
export const HORSE_RECORD_RESERVED_BYTES = 2048;
export const HORSE_TOMBSTONE_RESERVED_BYTES = 1024;
export const HORSE_HEADER_RESERVED_BYTES = 1024;
export const horseRecordBytes = (entry) => !entry ? 0 : entry.alive
  ? HORSE_RECORD_RESERVED_BYTES + HORSE_BASE_COPY_LIMIT * HORSE_BASE_RECORD_RESERVED_BYTES
  : HORSE_TOMBSTONE_RESERVED_BYTES;

export const horseId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 100;
export const horseHeading = (yaw) => Math.atan2(Math.sin(yaw), Math.cos(yaw));
export const horsePoint = ({ x, y, z }) => ({ x, y, z });
export const horseSeat = (position) => ({
  x: position.x, y: position.y + HORSE_SEAT_HEIGHT, z: position.z,
});
export const horseMotion = () => ({
  vx: 0, vy: 0, vz: 0, grounded: true, fallDistance: 0,
});
export const horseSynchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";

/** Transient rendering projection only; no stack, pose or ownership ledger. */
export function createHorseView(entry, environment = null) {
  return entry?.alive ? Object.freeze({
    tamed: entry.tamed === true,
    saddled: entry.saddle != null,
    ridden: entry.rider != null,
    grounded: (entry.motion?.grounded ?? environment?.grounded) === true,
    swimming: environment?.water === "deep",
  }) : null;
}

/** Parent supplies the real registry entry; this module never allocates an ID. */
export function isHorseSaddle(stack) {
  const item = getItem(stack?.id);
  return Number.isInteger(ITEM.SADDLE) && stack?.id === ITEM.SADDLE &&
    item?.stackSize === 1 && item.durability === undefined &&
    item.equipmentSlot === undefined && stack.count === 1;
}

const food = Object.freeze([
  ["WHEAT", 2, 3], ["APPLE", 3, 3], ["SUGAR", 1, 3],
  ["GOLDEN_CARROT", 4, 5], ["GOLDEN_APPLE", 10, 10],
]);
export function horseFood(id) {
  const match = food.find(([key]) => Number.isInteger(ITEM[key]) && ITEM[key] === id);
  return match ? Object.freeze({ heal: match[1], temper: match[2] }) : null;
}

/** Horse forward is +Z. Player aim remains -Z and is never rotated by riding. */
export function horseInput(keys, yaw, out = {}) {
  const down = (key) => keys?.has?.(key) === true;
  out.forward = Number(down("KeyW")) - Number(down("KeyS"));
  out.strafe = Number(down("KeyD")) - Number(down("KeyA"));
  out.yaw = Number.isFinite(yaw) ? yaw : 0;
  out.jump = down("Space");
  out.dismount = down("ShiftLeft") || down("ShiftRight");
  return out;
}
