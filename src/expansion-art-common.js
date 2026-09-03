import { painter, TEXTURE_SIZE } from "./pixel-art.js";

// Original five-tone ramps: seam, shade, body, grain, then cut-edge light.
// Boats and planks share these hues without depending on either item catalog.
export const EXPANSION_WOOD_PALETTES = Object.freeze(
  Object.fromEntries(
    Object.entries({
      oak: ["#624a31", "#85603c", "#a47b4b", "#bc955e", "#d3b27c"],
      spruce: ["#3c3025", "#56412d", "#705337", "#8a6a45", "#a18258"],
      birch: ["#877955", "#aea079", "#c9bd91", "#ddcfa4", "#eee1b9"],
      jungle: ["#634b39", "#876047", "#a97d58", "#c49770", "#d8b68d"],
      acacia: ["#683b2c", "#914c33", "#b76a42", "#cf8655", "#e1a471"],
      dark_oak: ["#2e231e", "#453126", "#5e422f", "#79583b", "#946d48"],
      mangrove: ["#532b2d", "#783d3c", "#9b514a", "#b76d60", "#ce8c7a"],
      cherry: ["#956268", "#bc8588", "#d6a4a3", "#e9bfbb", "#f4d7ce"],
      pale_oak: ["#8b827c", "#aea59c", "#cbc3b7", "#e0d8ca", "#eee8db"],
      bamboo: ["#81703b", "#a18b43", "#bca65a", "#d3c075", "#e6d699"],
      crimson: ["#452739", "#66394e", "#854961", "#a06077", "#bd8194"],
      warped: ["#234b4a", "#32655f", "#42877b", "#63a394", "#88c0ac"],
    }).map(([family, palette]) => [family, Object.freeze(palette)])
  )
);

export const EXPANSION_WOOD_FAMILIES = Object.freeze(
  Object.keys(EXPANSION_WOOD_PALETTES)
);

// Explicit material ramps for the tiered equipment sprites. The catalog and
// painters share descriptors; neither infers a tier from a display name.
export const EXPANSION_GEAR_PALETTES = Object.freeze(
  Object.fromEntries(
    Object.entries({
      wood: ["#443526", "#765237", "#a77b4c", "#c19b66", "#dfc18b"],
      stone: ["#343c42", "#647278", "#909d9f", "#b1bdba", "#d1d7cb"],
      copper: ["#553c33", "#915d46", "#c08359", "#dda273", "#f1c99a"],
      iron: ["#343b3c", "#73868a", "#b8c9c7", "#d1dbd5", "#e0e8df"],
      gold: ["#70502e", "#a47834", "#d0a54b", "#e8c574", "#f5dfac"],
      diamond: ["#254d52", "#38888a", "#61bfb8", "#91d8ce", "#c7eee0"],
      netherite: ["#252a2d", "#3c3c43", "#59515b", "#786671", "#a08b92"],
      leather: ["#4b302b", "#794936", "#a56d4b", "#c58d63", "#e0b88c"],
      chainmail: ["#303c43", "#506a72", "#779399", "#a0b9b8", "#cedbd3"],
      turtle: ["#2e4437", "#4d6943", "#7b9353", "#a9bd77", "#d5dfa3"],
    }).map(([material, palette]) => [material, Object.freeze(palette)])
  )
);

export function expansionArtVariants(definitions) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(definitions).map(([kind, variants]) => [
        kind,
        Object.freeze([...variants]),
      ])
    )
  );
}

// Inventory keys are kind/variant; a singleton "default" uses just kind.
export function expansionArtKeys(variants) {
  return Object.freeze(
    Object.entries(variants).flatMap(([kind, values]) =>
      values.map((variant) =>
        variant === "default" ? kind : `${kind}/${variant}`
      )
    )
  );
}

export function resolveExpansionVariant(options, variants) {
  if (
    !options ||
    typeof options !== "object" ||
    typeof options.kind !== "string" ||
    !Object.hasOwn(variants, options.kind)
  )
    return null;
  const allowed = variants[options.kind];
  const variant =
    options.variant === undefined && allowed.length === 1
      ? allowed[0]
      : options.variant;
  return allowed.includes(variant) ? variant : null;
}

// A handled painter replaces one complete tile, including its cutout pixels.
// Validate before clearing so invalid targets cannot be partly painted.
export function expansionPainter(pixels) {
  if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray))
    throw new TypeError(
      "Expansion art needs a Uint8Array or Uint8ClampedArray"
    );
  if (pixels.length !== TEXTURE_SIZE * TEXTURE_SIZE * 4)
    throw new RangeError("Expansion art needs exactly 16 × 16 RGBA pixels");
  pixels.fill(0);
  return painter(pixels);
}
