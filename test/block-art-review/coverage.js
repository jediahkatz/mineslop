import { BLOCK_CATALOG, BLOCKS } from "../../src/blocks.js";
import { facePartsFor, requiredCapturesFor, SYMBOLS } from "./cases.js";

export const CRITERIA = Object.freeze([
  "identity", "faces", "pixelArt", "lighting", "alphaEmission", "inventoryHeld", "states",
]);
export const CAPTURE_KIND = "mineslop-authored-production-block-art";
export const SURFACES = Object.freeze([
  "upper-north-east", "lower-south-west", "atlas-faces",
  "inventory-64", "inventory-32", "held-crop",
]);
const statuses = ["unreviewed", "needs-work", "blocked", "approved"];
const nonempty = (value, minimum = 1) =>
  typeof value === "string" && value.trim().length >= minimum;
const matrixKey = ({ case: key, light, labels }) => `${key}/${light}/${labels}`;

export function parseManifest(markdown) {
  const match = markdown.match(
    /<!-- mineslop-block-art-manifest:start -->\s*```text\s*\n([\s\S]*?)\n```\s*<!-- mineslop-block-art-manifest:end -->/,
  );
  if (!match) throw new Error("Missing machine-readable block art manifest");
  return match[1].split("\n").filter((line) => line.trim()).map((line) => {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length !== 4 || !/^\d+$/.test(fields[0]) ||
      !/^[A-Z][A-Z0-9_]*$/.test(fields[1]) || !statuses.includes(fields[2])
    ) throw new Error(`Malformed manifest row: ${line}`);
    return { id: Number(fields[0]), symbol: fields[1], status: fields[2], review: fields[3] };
  });
}

export function catalogAudit(rows, catalog = BLOCK_CATALOG) {
  const errors = [];
  const byId = new Map();
  const expected = new Set(catalog.map(({ id }) => id));
  for (const row of rows) {
    if (byId.has(row.id)) errors.push(`Duplicate manifest ID ${row.id}`);
    byId.set(row.id, row);
    if (!expected.has(row.id)) errors.push(`Unknown manifest ID ${row.id}`);
    if (row.symbol !== SYMBOLS.get(row.id)) errors.push(`Identity mismatch for ${row.id}`);
    if (!statuses.includes(row.status)) errors.push(`Unknown status for ${row.id}`);
    if (row.status === "approved" && row.review === "-")
      errors.push(`Approval without individual review for ${row.id}`);
  }
  for (const block of catalog)
    if (!byId.has(block.id)) errors.push(`New or missing catalog ID ${block.id} (${block.name})`);
  return {
    catalogCount: catalog.length,
    manifestCount: rows.length,
    counts: Object.fromEntries(statuses.map((status) =>
      [status, rows.filter((row) => row.status === status).length])),
    errors,
  };
}

function validCapture(capture, id, fingerprint, errors, path) {
  const prefix = `${id} capture ${path}`;
  if (capture?.kind !== CAPTURE_KIND || capture.schemaVersion !== 1) {
    errors.push(`${prefix}: wrong capture contract`);
    return [];
  }
  if (!capture.verifiedArtifact) errors.push(`${prefix}: PNG hash has not been verified`);
  if (capture.snapshot?.build?.sourceFingerprint !== fingerprint)
    errors.push(`${prefix}: stale source fingerprint`);
  if (!Array.isArray(capture.errors) || capture.errors.length)
    errors.push(`${prefix}: browser errors`);
  const cases = capture.snapshot?.cases?.filter((entry) => entry.id === id) ?? [];
  if (!cases.length) errors.push(`${prefix}: does not contain this block`);
  for (const entry of cases) {
    if (SURFACES.some((surface) => !entry.surfaces?.includes(surface)))
      errors.push(`${prefix}: missing presentation surfaces`);
    if (JSON.stringify(entry.faceParts) !== JSON.stringify(facePartsFor(id)))
      errors.push(`${prefix}: missing or changed face/part coverage`);
    if (
      entry.frames?.length !== 3 ||
      entry.frames.some((frame) => frame.glError !== 0 || frame.contextLost || frame.failedPrograms !== 0)
    ) errors.push(`${prefix}: GPU receipt failed or missing`);
  }
  return cases.map((entry) => ({
    case: entry.key,
    light: capture.snapshot.selection.light,
    labels: capture.snapshot.selection.labels,
  }));
}

/** A capture is not an approval. This checks individual evidence-backed decisions.
 * It cannot establish a person's honesty or aesthetic judgment; critics must still
 * inspect the actual images. There is intentionally no "approve all" operation.
 */
export function reviewAudit(rows, decisions, captures, fingerprint) {
  const audit = catalogAudit(rows);
  const errors = [...audit.errors];
  if (decisions?.schemaVersion !== 1 || !Array.isArray(decisions.records)) {
    errors.push("Invalid review decisions document");
    return { ...audit, errors, complete: false };
  }
  const byKey = new Map();
  const reviewedIds = new Set();
  for (const record of decisions.records) {
    if (byKey.has(record.key)) errors.push(`Duplicate review key ${record.key}`);
    if (reviewedIds.has(record.id)) errors.push(`Duplicate decision for ${record.id}`);
    if (!BLOCKS[record.id]) errors.push(`Review for unknown catalog ID ${record.id}`);
    byKey.set(record.key, record);
    reviewedIds.add(record.id);
  }
  for (const row of rows) {
    if (row.status !== "approved") continue;
    const record = byKey.get(row.review);
    const prefix = `${row.id} ${row.symbol}`;
    if (!record || record.id !== row.id) {
      errors.push(`${prefix}: missing block-specific review record`);
      continue;
    }
    if (record.sourceFingerprint !== fingerprint)
      errors.push(`${prefix}: stale review`);
    if (!Array.isArray(record.openFindings) || record.openFindings.length)
      errors.push(`${prefix}: unresolved or undeclared findings`);
    const paths = Array.isArray(record.captures) ? record.captures : [];
    const matrix = new Set();
    for (const path of paths) {
      const capture = captures.get(path);
      for (const view of validCapture(capture, row.id, fingerprint, errors, path))
        matrix.add(matrixKey(view));
    }
    for (const required of requiredCapturesFor(row.id))
      if (!matrix.has(matrixKey(required)))
        errors.push(`${prefix}: missing ${matrixKey(required)}`);
    const critics = Array.isArray(record.critics) ? record.critics : [];
    if (
      critics.length < 2 ||
      new Set(critics.map(({ reviewer }) => String(reviewer).trim().toLowerCase())).size !== critics.length ||
      !critics.some(({ role }) => role === "blind") ||
      !critics.some(({ role }) => role === "adversarial")
    ) errors.push(`${prefix}: two independent blind/adversarial critics required`);
    for (const critic of critics) {
      if (!nonempty(critic.reviewer) || !["blind", "adversarial"].includes(critic.role))
        errors.push(`${prefix}: invalid critic identity or role`);
      if (!Number.isFinite(Date.parse(critic.reviewedAt)))
        errors.push(`${prefix}: missing review timestamp`);
      if (
        !Number.isSafeInteger(critic.nearestConfusableId) ||
        !BLOCKS[critic.nearestConfusableId] || critic.nearestConfusableId === row.id ||
        !nonempty(critic.comparison, 24)
      ) errors.push(`${prefix}: explicit nearest-confusable comparison required`);
      for (const criterion of CRITERIA) {
        const decision = critic.criteria?.[criterion];
        if (decision?.verdict !== "pass" || !nonempty(decision.note, 24))
          errors.push(`${prefix}/${critic.reviewer}: ${criterion} lacks an individual passing judgment`);
        if (
          !Array.isArray(decision?.evidence) || !decision.evidence.length ||
          decision.evidence.some((path) => !paths.includes(path))
        ) errors.push(`${prefix}/${critic.reviewer}: ${criterion} lacks capture references`);
      }
      if (critic.role === "blind") {
        const capture = captures.get(critic.blindCapture);
        if (
          !paths.includes(critic.blindCapture) ||
          capture?.snapshot?.selection?.labels !== "blind" ||
          !capture?.snapshot?.cases?.some((entry) => entry.id === row.id) ||
          !nonempty(critic.initialGuess, 3) ||
          !Number.isFinite(Date.parse(critic.labelsRevealedAt)) ||
          !(Date.parse(critic.reviewedAt) <= Date.parse(critic.labelsRevealedAt)) ||
          !(Date.parse(capture?.createdAt) <= Date.parse(critic.reviewedAt))
        ) errors.push(`${prefix}: blind guess must be recorded against its capture before label reveal`);
      }
    }
  }
  return {
    ...audit,
    errors,
    complete: errors.length === 0 && rows.length > 0 &&
      rows.every(({ status }) => status === "approved"),
  };
}
