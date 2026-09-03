import * as THREE from "three";
import { BLOCK, BLOCKS } from "./blocks.js";
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
  const view = { camera, atlas, itemTextures, left, itemId: 0, swing: 0 };
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
  view.itemId = getItem(id) ? id : 0;
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
  view.swing = 0.3;
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

function placeInView(view, x, y, depth, tangent, aspect) {
  view.hand.position.set(
    x * depth * tangent * aspect,
    y * depth * tangent,
    -depth
  );
}

export function updateHeldItemView(view, dt, elapsed, moving, visible, use) {
  const side = view.left ? -1 : 1;
  const tangent = Math.tan(((view.camera.fov ?? 75) * Math.PI) / 360);
  const aspect = view.camera.aspect ?? 1;
  view.swing = Math.max(0, (view.swing ?? 0) - Math.max(0, dt) * 5);
  view.hand.visible = Boolean(visible && (!view.left || view.itemId));
  // Anchor to screen edges instead of a fixed world-space camera offset, which
  // intrudes into the hotbar/vitals at narrower aspects and larger GUI scales.
  view.hand.scale.setScalar((0.85 * tangent) / Math.tan((75 * Math.PI) / 360));
  placeInView(view, side * 0.76, -0.75, 0.82, tangent, aspect);
  if (moving) view.hand.position.y += Math.sin(elapsed * 11) * 0.006;
  view.hand.rotation.set(
    0.15 - Math.sin(view.swing * Math.PI) * 0.8,
    side * -0.4,
    side * 0.08
  );
  const shield = getItem(view.itemId)?.tool === "shield";
  view.itemMesh?.scale.setScalar(shield ? 1.35 : 1);
  view.itemMesh?.rotation.set(0, side * 0.5, side * -0.28);
  if (!use?.active || use.hand !== (view.left ? "offhand" : "main")) return;
  if (use.kind === "food") {
    placeInView(view, side * 0.42, -0.26, 0.72, tangent, aspect);
    view.hand.position.y += Math.sin(elapsed * 28) * 0.012;
    view.hand.rotation.x = -0.3;
  } else if (use.kind === "bow") {
    placeInView(view, side * 0.33, -0.42, 0.76, tangent, aspect);
    view.hand.rotation.set(0.06, side * -0.15, side * 0.08);
    view.itemMesh?.scale.set(1, 1 + Math.min(1, use.progress) * 0.12, 1);
  } else if (use.kind === "shield") {
    placeInView(view, side * 0.48, -0.3, 0.75, tangent, aspect);
    view.hand.rotation.set(0, 0, side * 0.04);
    view.itemMesh?.rotation.set(0, side * 0.12, 0);
    view.itemMesh?.scale.setScalar(1.6);
  }
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
