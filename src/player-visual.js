import * as THREE from "three";
import { createPlayerRig, posePlayerRig } from "./player-rig.js";
import { createPlayerSkinResources, MAX_PLAYER_PARTS } from "./player-skin.js";

/**
 * Third-person appearance only. dt is seconds; position is physical feet XYZ.
 * update(dt, { position, yaw, pitch, moving, sprinting, crouching, bodyHeight,
 *   eyeHeight, velocityY, seated = false, perspective, mainHand, offhand,
 *   equipment, hurtTint, vehicleType, hullYaw }).
 * Hands/equipment take canonical { id, count, durability? } stacks or null.
 * Seated bends the shared rig's legs/arms, suppressing gait without changing
 * the physical feet/eye envelope, aim, skins, held items or equipment ownership.
 * For any horse rider (including untamed/bareback), parent also passes
 * vehicleType:"horse" and the committed rider pose's hullYaw in Player's -Z
 * convention. The body straddles/follows that heading; the head retains physical
 * yaw/pitch. Never assign hullYaw to Player/camera aim. Boats ignore hullYaw.
 * Omitted vehicleType keeps the existing boat seating. Standing and the
 * separately posed inventory portrait retain their existing appearance.
 * The caller owns camera/F5 controls, hand HUD visibility and gameplay rays.
 * Call update in first person too: that transition releases the GPU batch.
 * Dispose on world teardown; create another instance for the next world.
 *
 * Held blocks/items use modest color-matched cuboids and tool silhouettes;
 * they do not load inventory sprites or fabricate stack/equipment state.
 */
export class PlayerVisual {
  constructor(scene) {
    if (!scene?.isScene)
      throw new TypeError("PlayerVisual requires a Three scene");
    this.scene = scene;
    this.rig = null;
    this.mesh = null;
    this.resources = null;
    this.hurtColor = new THREE.Color("#ff554c");
    this.partColor = new THREE.Color();
    this.disposed = false;
  }

  get visible() {
    return this.mesh !== null;
  }

  update(dt, state) {
    if (this.disposed) return;
    const position = state?.position;
    if (
      (state?.perspective !== "back" && state?.perspective !== "front") ||
      !position ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      this.releaseBatch();
      return;
    }
    this.rig ??= createPlayerRig();
    posePlayerRig(this.rig, dt, state);
    if (!this.mesh) {
      this.resources = createPlayerSkinResources();
      this.resources.flashes.setUsage(THREE.DynamicDrawUsage);
      this.mesh = new THREE.InstancedMesh(
        this.resources.geometry,
        this.resources.material,
        MAX_PLAYER_PARTS
      );
      this.mesh.name = "Original third-person player";
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.setColorAt(0, this.rig.parts[0].color);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.mesh.frustumCulled = false;
      this.mesh.castShadow = true;
      this.mesh.receiveShadow = true;
      this.scene.add(this.mesh);
    }
    // All Float32 instance translations stay within the local human rig.
    // Three combines this double-precision world origin with the camera on
    // the CPU, preserving the same anatomy at +/-29M and at high altitude.
    this.mesh.position.copy(position);
    const hurt = Number.isFinite(state.hurtTint)
      ? Math.max(0, Math.min(1, state.hurtTint))
      : 0;
    let count = 0;
    for (const part of this.rig.parts) {
      if (!part.visible) continue;
      this.mesh.setMatrixAt(count, part.node.matrixWorld);
      this.mesh.setColorAt(
        count,
        this.partColor.copy(part.color).lerp(this.hurtColor, hurt)
      );
      this.resources.write(count, part.skin);
      this.resources.flashes.setX(count, hurt * 0.65);
      count++;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.resources.flashes.needsUpdate = true;
    this.resources.update();
    this.mesh.updateMatrixWorld(true);
  }

  releaseBatch() {
    if (!this.mesh) return;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.resources.dispose();
    this.mesh = null;
    this.resources = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseBatch();
    this.rig = null;
  }
}
