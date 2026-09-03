import { BLOCK_CATALOG, BLOCKS } from "../../src/blocks.js";
import { blockIcon, blockTexturePixels, tileFor } from "../../src/textures.js";
import manifestText from "../../docs/block-art-review.md?raw";
import {
  CATALOG_GROUPS,
  facePartsFor,
  PAGE_SIZE,
  resolvedSubjects,
  REVIEW_VERSION,
  specialAccounting,
  SYMBOLS,
} from "./cases.js";
import { CAPTURE_KIND, catalogAudit, parseManifest, SURFACES } from "./coverage.js";
import { sheetPlan } from "./plan.js";
import { createReviewRenderer } from "./render.js";

const api = {
  ready: false,
  busy: false,
  error: null,
  version: REVIEW_VERSION,
  kind: CAPTURE_KIND,
};
window.__mineslopBlockArtReview = api;
let current = null;
let renderer = null;
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const figure = (image, caption, className) => {
  const node = element("figure", undefined, className);
  node.append(image, element("figcaption", caption));
  return node;
};

function faceCanvas(id, face, part) {
  const pixels = blockTexturePixels(id, face, part ?? undefined);
  const canvas = element("canvas", undefined, "checker");
  canvas.width = canvas.height = 16;
  const context = canvas.getContext("2d");
  const image = context.createImageData(16, 16);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas;
}

async function icon(id, className) {
  const image = element("img", undefined, `checker ${className}`);
  image.alt = "Production inventory icon";
  image.src = blockIcon(id);
  await image.decode();
  return image;
}

async function card(reviewCase, selection) {
  const block = BLOCKS[reviewCase.id];
  const labeled = selection.labels === "labeled";
  const node = element("article", undefined, "card");
  node.append(
    element("h2", labeled ? `${reviewCase.token} · ${block.name}` : reviewCase.token),
    element("p", labeled ? `${block.id} · ${SYMBOLS.get(block.id)} · ${reviewCase.key}`
      : "Identity withheld · evaluate silhouette and material", "identity"),
  );
  const rendered = await renderer.renderCase(reviewCase, selection.light);
  const worlds = element("div", undefined, "worlds");
  worlds.append(
    figure(rendered.images[0], "Placed · upper / north / east"),
    figure(rendered.images[1], "Placed · lower / south / west"),
  );
  node.append(worlds);
  const faces = element("div", undefined, "faces");
  for (const { face, part } of facePartsFor(block.id)) {
    faces.append(figure(faceCanvas(block.id, face, part),
      `${part === null ? "" : `${part} · `}${face} · 16px at 6×`));
  }
  node.append(faces);
  const presentation = element("div", undefined, "presentation");
  const inventory = element("div", undefined, "inventory");
  inventory.append(await icon(block.id, "large"), await icon(block.id, "small"));
  presentation.append(
    figure(inventory, "Production icon · 64px / 32px"),
    figure(rendered.images[2], "Production held view · 1× crop", "held"),
  );
  node.append(presentation);
  node.append(element("p", labeled
    ? (specialAccounting(block.id) ?? reviewCase.note) || "Review material identity, face continuity and the real production presentation."
    : "Authored fixture. Record your identity guess and nearest confusable material before seeing labels.",
  "note"));
  const { images, ...receipt } = rendered;
  return {
    node,
    receipt: {
      id: block.id,
      key: reviewCase.key,
      token: reviewCase.token,
      name: block.name,
      symbol: SYMBOLS.get(block.id),
      cells: reviewCase.cells,
      faceParts: facePartsFor(block.id),
      textureTiles: facePartsFor(block.id).map(({ face, part }) =>
        tileFor(block.id, face, part ?? undefined)),
      surfaces: [...SURFACES],
      shapes: resolvedSubjects(reviewCase).map((shape) => ({
        kind: shape.kind, part: shape.part, textureAxis: shape.textureAxis,
        link: shape.link ?? null, attachment: shape.attachment ?? null,
        corner: shape.corner ?? null, connections: shape.connections ?? null,
      })),
      ...receipt,
    },
  };
}

api.render = async (input = {}) => {
  if (api.busy) throw new Error("A sheet is already rendering");
  api.busy = true;
  api.ready = false;
  api.error = null;
  current = null;
  const status = document.querySelector("#status");
  try {
    const build = typeof __MINESLOP_BLOCK_ART_BUILD__ === "undefined"
      ? null : __MINESLOP_BLOCK_ART_BUILD__;
    if (!build) throw new Error("Use the dedicated block-art-review Vite config");
    const audit = catalogAudit(parseManifest(manifestText));
    if (audit.errors.length) throw new Error(audit.errors.join("; "));
    const plan = sheetPlan(input);
    const { selection } = plan;
    document.querySelector("#title").textContent = selection.labels === "blind"
      ? `Blind review · ${selection.light} · sheet ${selection.page + 1} of ${plan.pages}`
      : `${selection.group} · ${selection.set} · ${selection.light} · sheet ${selection.page + 1} of ${plan.pages}`;
    status.classList.remove("failed");
    status.textContent = `Rendering ${plan.cases.length} samples; no visual approval is implied`;
    const sheets = document.querySelector("#sheets");
    sheets.replaceChildren();
    renderer ??= createReviewRenderer(document.querySelector("#gpu"));
    const cases = [];
    for (const reviewCase of plan.cases) {
      const result = await card(reviewCase, selection);
      sheets.append(result.node);
      cases.push(result.receipt);
    }
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    current = {
      version: REVIEW_VERSION,
      kind: CAPTURE_KIND,
      build,
      selection,
      catalogCount: BLOCK_CATALOG.length,
      manifest: audit,
      cases,
      pageSize: PAGE_SIZE,
      totalCases: plan.totalCases,
      pages: plan.pages,
      devicePixelRatio: window.devicePixelRatio,
      limitations: [
        "Authored production-component QA fixture, not natural gameplay.",
        "Neutral untinted stage. No biome tint, local point lights, gameplay UI, water animation or performance claim.",
        "Production atmosphere lights at fixed time; world shadows use a hidden-color stone roof and a close shadow frustum.",
        "Held preview is an unscaled crop of the production first-person view; the shadow preset is ambient-only.",
        "Current production representations are preserved, including simplified inventory/held shapes and special cells.",
      ],
    };
    status.textContent = `${BLOCK_CATALOG.length} catalog IDs accounted for · ${cases.length} samples rendered · manifest approvals ${audit.counts.approved} (unverified here) · source ${build.sourceFingerprint}`;
    api.ready = true;
    return api.snapshot();
  } catch (error) {
    api.error = String(error?.stack ?? error);
    status.textContent = api.error;
    status.classList.add("failed");
    throw error;
  } finally {
    api.busy = false;
  }
};
api.snapshot = () => current ? structuredClone(current) : null;
api.groups = () => [...CATALOG_GROUPS];
api.dispose = () => {
  renderer?.dispose();
  api.ready = false;
};
window.addEventListener("error", (event) => {
  api.error = event.message;
  api.ready = false;
});
window.addEventListener("unhandledrejection", (event) => {
  api.error = String(event.reason);
  api.ready = false;
});
api.render(Object.fromEntries(new URLSearchParams(location.search))).catch(() => {});
