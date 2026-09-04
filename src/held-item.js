import * as THREE from "three";
import { BLOCK, BLOCKS } from "./blocks.js";
import {
  advanceHeldMotion,
  composeHeldMotion,
  createHeldMotion,
  requestHeldSelection,
} from "./held-motion.js";
import { getItem, isBlockItem } from "./items.js";
import { itemIcon } from "./textures.js";

export function usesHeldSprite(id) {
  return Boolean(
    getItem(id) &&
      (!isBlockItem(id) ||
        BLOCKS[id]?.shape === "cross" ||
        BLOCKS[id]?.heldSprite)
  );
}

export function createHeldItemView(camera, atlas, itemTextures, left = false) {
  const view = {
    camera, atlas, itemTextures, left, itemId: 0, swing: 0,
    motion: createHeldMotion(),
    // matches stays current; no per-frame matchMedia calls or listeners.
    motionPreference: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)"),
  };
  view.hand = new THREE.Group();
  view.hand.name = left ? "Offhand item" : "Main-hand item";
  view.handGeometry = new THREE.BoxGeometry(0.19, 0.19, 0.19);
  view.handMaterial = new THREE.MeshLambertMaterial({
    map: atlas.texture,
    alphaTest: 0.12,
  });
  view.held = new THREE.Mesh(view.handGeometry, view.handMaterial);
  view.held.rotation.set(0.12, left ? -0.35 : 0.35, left ? -0.05 : 0.05);
  view.hand.add(view.held);
  view.itemGeometry = new THREE.PlaneGeometry(0.3, 0.3);
  view.itemMaterial = new THREE.MeshLambertMaterial({
    transparent: true,
    alphaTest: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  view.itemMesh = new THREE.Mesh(view.itemGeometry, view.itemMaterial);
  view.itemMesh.visible = false;
  view.hand.add(view.itemMesh);
  view.armGeometry = new THREE.BoxGeometry(0.13, 0.3, 0.13);
  view.armMaterial = new THREE.MeshLambertMaterial({ color: "#c99870" });
  view.arm = new THREE.Mesh(view.armGeometry, view.armMaterial);
  view.arm.position.set(left ? -0.025 : 0.025, -0.2, 0.055);
  view.arm.rotation.x = -0.3;
  view.hand.add(view.arm);
  camera.add(view.hand);
  updateHeldItemView(view, 0, 0, false, false);
  return view;
}

/** The two hands share immutable image textures, never mutable UVs/materials. */
export function selectHeldItem(view, id) {
  const nextId = getItem(id) ? id : 0;
  if (nextId !== view.itemId) requestHeldSelection(view.motion);
  view.itemId = nextId;
  const sprite = Boolean(view.itemId && usesHeldSprite(id));
  const block = !sprite && id > 0 ? BLOCKS[id] : null;
  if (view.held) view.held.visible = Boolean(block);
  if (view.itemMesh) {
    view.itemMesh.visible = sprite;
    if (sprite) {
      if (!view.itemTextures.has(id)) {
        const texture = new THREE.TextureLoader().load(itemIcon(id));
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        view.itemTextures.set(id, texture);
      }
      view.itemMaterial.map = view.itemTextures.get(id);
      view.itemMaterial.needsUpdate = true;
    }
  }
  if (!block) return;
  view.handMaterial.transparent = id === BLOCK.GLASS;
  view.handMaterial.depthWrite = id !== BLOCK.GLASS;
  view.handMaterial.opacity = id === BLOCK.GLASS ? 0.7 : 1;
  view.handMaterial.needsUpdate = true;
  const uv = view.handGeometry.getAttribute("uv");
  for (let face = 0; face < 6; face++) {
    const [u0, v0, u1, v1] = view.atlas.uvFor(
      id,
      face === 2 ? "top" : face === 3 ? "bottom" : "side"
    );
    uv.setXY(face * 4, u0, v1);
    uv.setXY(face * 4 + 1, u1, v1);
    uv.setXY(face * 4 + 2, u0, v0);
    uv.setXY(face * 4 + 3, u1, v0);
  }
  uv.needsUpdate = true;
}

/**
 * Call once for each accepted mining update, before Effects.update(). This
 * renews visual motion only; it neither reads nor changes mining progress.
 * Effects copies the view fields, so its main hand already owns this state.
 */
export function requestHeldItemMining(view) {
  view.motion ??= createHeldMotion();
  view.motion.miningRequested = true;
}

function placeInView(view, x, y, depth, tangent, aspect) {
  view.hand.position.set(
    x * depth * tangent * aspect,
    y * depth * tangent,
    -depth
  );
}

// locomotion is a read-only accepted pose observation; bob:false disables
// locomotion decoration without suppressing food/bow/shield/action feedback.
export function updateHeldItemView(view, dt, elapsed, moving, visible, use, locomotion) {
  const tangent = Math.tan(((view.camera.fov ?? 75) * Math.PI) / 360);
  const aspect = view.camera.aspect ?? 1;
  view.hand.visible = Boolean(visible && (!view.left || view.itemId));
  const kind = use?.active &&
    use.hand === (view.left ? "offhand" : "main") &&
    (use.itemId === undefined || use.itemId === view.itemId) ? use.kind : null;
  // Visual phases follow bounded frame dt, never global/day time or a paused
  // clock jump. Keep elapsed in the shared Effects view signature.
  const motion = view.motion;
  const step = advanceHeldMotion(
    motion, dt, moving, view.hand.visible, kind, use?.progress, view.swing,
    locomotion
  );
  if (step || !view.hand.visible) view.swing = 0;
  const shield = getItem(view.itemId)?.tool === "shield";
  const reducedMotion = Boolean(view.motionPreference?.matches);
  const pose = composeHeldMotion(motion, view.left, shield, reducedMotion);
  // Anchor to screen edges instead of a fixed world-space camera offset, which
  // intrudes into the hotbar/vitals at narrower aspects and larger GUI scales.
  view.hand.scale.setScalar((0.85 * tangent) / Math.tan((75 * Math.PI) / 360));
  placeInView(view, pose.x, pose.y, pose.depth, tangent, aspect);
  view.hand.rotation.set(pose.rx, pose.ry, pose.rz);
  view.itemMesh?.scale.set(pose.scale, pose.scaleY, pose.scale);
  view.itemMesh?.rotation.set(0, pose.itemYaw, pose.itemRoll);
}

export function disposeHeldItemView(view) {
  view.camera.remove(view.hand);
  for (const key of [
    "handGeometry",
    "handMaterial",
    "itemGeometry",
    "itemMaterial",
    "armGeometry",
    "armMaterial",
  ])
    view[key].dispose();
}
