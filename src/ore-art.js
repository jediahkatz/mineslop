import { BLOCK } from "./blocks.js";
import { painter } from "./pixel-art.js";

// Hand-authored layouts informed by the vanilla Java 26.2 mineral families.
// These stamps are not imported reference pixels. Dots preserve the host, and
// each mineral keeps its own distribution rather than recoloring one template.
const DEPOSITS = new Map([
  [
    BLOCK.COAL_ORE,
    {
      // Gritty dark pockets and small grains, without silver cleavage highlights.
      palette: ["#141515", "#2b2c29", "#393b35", "#505147"],
      patches: [
        [3, 1, [".321.", "21012", ".100."]],
        [11, 2, ["21", "10"]],
        [1, 5, ["21", "10"]],
        [7, 5, ["221.", "1003", ".110"]],
        [2, 10, [".321", "2100", "110."]],
        [11, 10, [".21", "210", "100"]],
        [7, 13, ["221", "110"]],
        [4, 14, ["10"]],
      ],
    },
  ],
  [
    BLOCK.IRON_ORE,
    {
      // Warm peach exposures are dispersed among smaller brown interruptions.
      palette: ["#78644f", "#94775e", "#af8d72", "#d2a88e", "#e3bfa7"],
      patches: [
        [1, 2, ["210", "321", ".10"]],
        [9, 1, [".21", "321", "110"]],
        [5, 5, [".321", "3421", ".210"]],
        [12, 6, ["21", "32", "10"]],
        [1, 8, [".21", "321", "210"]],
        [6, 10, [".32", "342", "210"]],
        [11, 12, ["321", "210"]],
        [2, 13, ["21", "10"]],
        [7, 3, ["1"]],
      ],
    },
  ],
  [
    BLOCK.GOLD_ORE,
    {
      // Saturated orange-gold pockets have small pale-yellow cores, not dull ochre.
      palette: ["#94681e", "#c37e16", "#eca21a", "#ffe24b", "#fff6ab"],
      patches: [
        [2, 3, [".21.", "1342", "2321", ".210"]],
        [11, 1, [".21", "321", ".10"]],
        [1, 9, ["32", "21", "10"]],
        [9, 10, [".321.", "34221", ".2110", "..10."]],
        [2, 13, ["3421", ".210"]],
        [13, 7, ["21", "10"]],
        [7, 1, ["2"]],
      ],
    },
  ],
  [
    BLOCK.DIAMOND_ORE,
    {
      // Short cyan cuts and scattered chips replace a few large rounded masses.
      palette: ["#638b8f", "#238d91", "#2bcdd0", "#77e5d0", "#ccf8ed"],
      patches: [
        [1, 2, ["32", "10"]],
        [6, 1, ["3", "1"]],
        [11, 3, ["43", "21"]],
        [3, 5, [".321", "4320", "11.."]],
        [9, 6, ["32.", "210", ".10"]],
        [0, 9, ["32", "10"]],
        [5, 10, [".32.", "4321", ".10."]],
        [10, 11, ["..3.", "4321", ".211"]],
        [4, 14, ["31"]],
      ],
    },
  ],
  [
    BLOCK.COPPER_ORE,
    {
      // The vanilla pairing includes substantial green exposures, not rare flecks.
      palette: [
        "#777759",
        "#b75f40",
        "#d77753",
        "#ed9473",
        "#34765f",
        "#55ae8c",
      ],
      patches: [
        [1, 2, ["445..", ".4521", "..230"]],
        [11, 1, ["23", "10"]],
        [7, 5, [".445", "5421", "..10"]],
        [1, 7, ["45..", "5423", ".421"]],
        [11, 7, [".43", "542", "421"]],
        [5, 11, ["..43", "5421", ".230"]],
        [1, 13, ["45", "40"]],
        [13, 13, ["54"]],
      ],
    },
  ],
  [
    BLOCK.REDSTONE_ORE,
    {
      // Red-hot color is diffuse pigment here; it does not enable block emission.
      palette: ["#926666", "#8f080b", "#c9090b", "#f82528", "#ff6868"],
      patches: [
        [3, 2, [".110.", "12321", ".3442"]],
        [12, 4, ["23", "10"]],
        [1, 7, ["132", "342", "010"]],
        [8, 8, ["11221", "23342", ".100."]],
        [3, 12, ["1221", "3442", ".10."]],
        [11, 13, ["32", "10"]],
        [7, 5, ["1"]],
      ],
    },
  ],
  [
    BLOCK.EMERALD_ORE,
    {
      // Small square-cut green facets are an intended material cue in Java 26.2.
      palette: ["#305a38", "#0c7e2c", "#19c855", "#4be780", "#cef6da"],
      patches: [
        [1, 1, ["034", "021"]],
        [10, 2, ["043", "021"]],
        [5, 5, [".431", "3421", "2210"]],
        [12, 8, ["043", "021", ".10"]],
        [7, 11, [".43", "342", "211", "010"]],
        [2, 13, ["034", "021"]],
      ],
    },
  ],
  [
    BLOCK.LAPIS_ORE,
    {
      // Cobalt bands and offset grains replace the three blue medallions.
      palette: ["#254576", "#194daf", "#2868ce", "#4e80de", "#789def"],
      patches: [
        [1, 1, ["21", "10"]],
        [6, 2, ["31"]],
        [12, 1, ["21", "10"]],
        [3, 5, ["..321", "43221", ".100."]],
        [9, 6, ["21", "32", ".1"]],
        [1, 9, ["432", "110"]],
        [6, 10, ["32..", "231.", "0121", ".321"]],
        [12, 10, ["21", "32", "43", "10"]],
        [3, 13, ["21", "32", "10"]],
      ],
    },
  ],
]);

export function paintOreDeposits(pixels, id) {
  const deposit = DEPOSITS.get(id);
  if (!deposit) throw new RangeError(`No mineral art for block ${id}`);
  const { stamp } = painter(pixels);
  for (const [x, y, shape] of deposit.patches) {
    stamp(x, y, shape, deposit.palette);
  }
}
