import { BLOCK } from "./blocks.js";
import { painter } from "./pixel-art.js";

// Original deposits: underlap, shadow, mineral, cut facet, then optional accents.
// Dots retain the geological host, including open cuts into a mineral fragment.
// Facets meet the host directly; the darker inks need not enclose every deposit.
const DEPOSITS = new Map([
  [
    BLOCK.COAL_ORE,
    {
      // Neutral charcoal with sparse broken cleavage, not olive weathering.
      palette: ["#202328", "#30343a", "#44494f", "#727a81"],
      patches: [
        [1, 2, ["..21..", ".31110", "211001", "1100..", ".01..."]],
        [10, 1, ["..31", ".110", "210."]],
        [8, 8, [".210..", "31100.", ".10.12", "..0011", "...01."]],
        [2, 12, [".32.", "1101", ".00."]],
      ],
    },
  ],
  [
    BLOCK.IRON_ORE,
    {
      palette: ["#746f64", "#927963", "#b3977b", "#d0b598"],
      patches: [
        [1, 3, [".030.", "03210", ".2100"]],
        [9, 1, [".0300", "03221", "..110"]],
        [4, 10, ["0030.", "03210", ".2110"]],
        [11, 7, [".030", "0321", "1210", ".10."]],
      ],
    },
  ],
  [
    BLOCK.GOLD_ORE,
    {
      palette: ["#807044", "#a58035", "#cba64b", "#e1c271", "#ead495"],
      patches: [
        [1, 2, ["...32..", ".34221.", "3222.21", ".211.20", "..10..."]],
        [11, 1, [".32", "221", ".10"]],
        [8, 9, ["..3.2.", ".32221", "221.20", ".10..."]],
        [2, 12, ["322.", ".210"]],
      ],
    },
  ],
  [
    BLOCK.DIAMOND_ORE,
    {
      palette: ["#587873", "#438e89", "#67bdb4", "#8bcfc4", "#b0ded2"],
      patches: [
        [1, 1, ["..32.", ".3421", "221..", "10..."]],
        [11, 5, [".43.", "3221", "..10"]],
        [3, 9, ["...32..", ".33221.", "3422.21", "2221.10", ".211..."]],
        [11, 12, [".32", "221", "10."]],
      ],
    },
  ],
  [
    BLOCK.COPPER_ORE,
    {
      palette: [
        "#756153",
        "#985b43",
        "#c57d55",
        "#d99c73",
        "#528778",
        "#74a28d",
      ],
      patches: [
        [1, 2, [".43....", "54221..", "422.210", ".10.21."]],
        [10, 1, ["..32", ".221", "310."]],
        [7, 9, ["..45...", ".442.3.", "5422221", ".221.10", "..10..."]],
        [1, 12, ["32.", "221", ".10"]],
      ],
    },
  ],
  [
    BLOCK.REDSTONE_ORE,
    {
      palette: ["#75444a", "#8f3038", "#b44347", "#cc6565"],
      patches: [
        [2, 1, ["..32..", "322210", "221.1.", ".10..."]],
        [11, 4, ["32.", "221", ".10"]],
        [1, 9, ["...32..", ".33221.", "222.21.", ".211.10", "..10..."]],
        [10, 11, [".32.", "3221", "110."]],
      ],
    },
  ],
  [
    BLOCK.EMERALD_ORE,
    {
      palette: ["#596f5c", "#2f7651", "#439c65", "#75bb87", "#a3d4ae"],
      patches: [
        [1, 3, ["..332..", "3422210", ".21.10."]],
        [10, 1, ["...3", "..42", ".321", "221.", "10.."]],
        [6, 9, ["..32..", ".43221", "322.10", "21..1.", ".10..."]],
        [1, 12, ["32.", "221", "10."]],
      ],
    },
  ],
  [
    BLOCK.LAPIS_ORE,
    {
      palette: ["#626d80", "#304e7c", "#476da2", "#7492bb"],
      patches: [
        [1, 2, ["..00.", "00330", "03221", ".1210", "..00."]],
        [10, 1, [".00", "033", "121", "110"]],
        [7, 10, ["..00.", "00330", "03221", "12210", ".110."]],
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
