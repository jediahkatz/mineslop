import { painter } from "./pixel-art.js";

const rim = "#343b3c";
const shade = "#73868a";
const metal = "#b8c9c7";
const light = "#e0e8df";

/** Original equipment silhouettes; the untouched pixels remain transparent. */
export function paintEquipmentItem(pixels, name) {
  const { rect, line } = painter(pixels);
  if (name === "SHIELD") {
    rect(3, 1, 10, 10, rim);
    rect(4, 10, 8, 2, rim);
    rect(5, 12, 6, 1, rim);
    rect(6, 13, 4, 1, rim);
    rect(7, 14, 2, 1, rim);
    rect(4, 2, 8, 8, metal);
    rect(5, 10, 6, 2, shade);
    rect(6, 12, 4, 1, shade);
    rect(7, 13, 2, 1, shade);
    rect(5, 3, 6, 7, "#956c48");
    rect(6, 10, 4, 2, "#77563e");
    line(6, 4, 6, 10, "#b68b5c");
    line(9, 4, 9, 10, "#694e3a");
    rect(4, 2, 8, 1, light);
    rect(4, 3, 1, 6, light);
    rect(5, 4, 1, 1, metal);
    rect(10, 4, 1, 1, metal);
  } else if (name === "IRON_HELMET") {
    rect(4, 2, 8, 2, rim);
    rect(2, 4, 12, 8, rim);
    rect(3, 4, 10, 5, metal);
    rect(5, 3, 6, 1, light);
    rect(3, 5, 2, 6, metal);
    rect(11, 5, 2, 6, shade);
    rect(5, 9, 6, 4, [0, 0, 0, 0]);
    rect(4, 4, 7, 1, light);
    rect(3, 10, 2, 1, shade);
  } else if (name === "IRON_LEGGINGS") {
    rect(3, 2, 10, 5, rim);
    rect(3, 6, 4, 9, rim);
    rect(9, 6, 4, 9, rim);
    rect(4, 3, 8, 4, metal);
    rect(4, 7, 2, 7, metal);
    rect(10, 7, 2, 7, shade);
    rect(4, 3, 8, 1, light);
    rect(4, 7, 1, 6, light);
    rect(7, 5, 2, 1, shade);
    rect(4, 13, 2, 1, shade);
  } else if (name === "IRON_BOOTS") {
    for (const x of [2, 9]) {
      rect(x + 1, 4, 4, 8, rim);
      rect(x, 10, 5, 4, rim);
      rect(x + 2, 5, 2, 6, metal);
      rect(x + 1, 11, 3, 2, metal);
      rect(x + 2, 5, 2, 1, light);
      rect(x + 1, 11, 3, 1, light);
      rect(x + 1, 13, 3, 1, shade);
    }
  } else return false;
  return true;
}
