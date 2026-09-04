// Schema capability, not the new-world default. Unknown future versions fail
// closed; explicit v6 support must never silently migrate an older saved world.
export const SUPPORTED_GENERATOR_VERSIONS = Object.freeze([1, 2, 3, 4, 5, 6]);
export const isSupportedGeneratorVersion = (version) =>
  SUPPORTED_GENERATOR_VERSIONS.includes(version);
export const hasExpandedTerrain = (version) => version === 4 || version === 5 || version === 6;
