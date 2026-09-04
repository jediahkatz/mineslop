import { BLOCK } from "./blocks.js";

export const CONTAINER_BLOCKS = new Map([
  [BLOCK.CHEST, "chest"],
  [BLOCK.BARREL, "barrel"],
  [BLOCK.FURNACE, "furnace"],
  [BLOCK.BLAST_FURNACE, "blast_furnace"],
]);
export const CONTAINER_TITLES = Object.freeze({
  chest: "Chest",
  barrel: "Barrel",
  furnace: "Furnace",
  blast_furnace: "Blast Furnace",
});
export const isStorageKind = (kind) => kind === "chest" || kind === "barrel";
export const isFurnaceKind = (kind) =>
  kind === "furnace" || kind === "blast_furnace";
export const containerRecordKind = (kind) =>
  isFurnaceKind(kind) ? "furnace" : kind;
