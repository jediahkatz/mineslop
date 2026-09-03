// Original geometric UI glyphs. No game textures or Mojang assets are used.
const paths = {
  heart: "M1 2h2V1h2v1h1V1h2v1h2v3H9v1H8v1H7v1H6v1H5V8H4V7H3V6H2V5H1Z",
  hunger: "M5 1h3v1h1v4H8v1H5V6H4V3h1ZM3 6h2v2H3v2H1V8h2Z",
  air: "M3 1h4v1h2v2h1v3H9v2H7v1H3V9H1V7H0V4h1V2h2Zm0 2v2h1V3Z",
  armor: "M3 1h2v2h1V1h2v1h2v3H8v5H2V5H0V2h3Z",
  helmet: "M2 1h6v1h1v7H7V5H3v4H1V2h1Z",
  chest: "M2 1h2v2h2V1h2v1h2v3H8v5H2V5H0V2h2Z",
  legs: "M2 1h6v9H6V5H4v5H2Z",
  feet: "M2 2h2v5h1v3H0V7h2Zm4 0h2v5h2v3H5V7h1Z",
  shield: "M1 1h8v6H8v1H7v1H6v1H4V9H3V8H2V7H1Z",
  book: "M1 1h3v1h2V1h3v8H6v1H4V9H1Zm1 2v4h1V3Zm5 0v4h1V3Z",
  search:
    "M2 0h4v1h1v1h1v4H7v1H6v1H2V7H1V6H0V2h1V1h1Zm0 2v4h4V2Zm5 5h1v1h1v1h1v1H8V9H7Z",
  flame: "M5 0h1v3h2v2h1v2h1v2H9v1H7v1H3v-1H1V9H0V6h1V4h1v3h1V4h1V2h1Z",
};

export function pixelIcon(name) {
  return `<svg viewBox="0 0 10 11" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><path d="${paths[name] || paths.armor}"/></svg>`;
}
