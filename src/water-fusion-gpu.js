import * as THREE from "three";

function checked(renderer, label, action) {
  const gl = renderer.getContext();
  if (gl.isContextLost()) throw new Error(`Water ${label}: context lost`);
  const prior = gl.getError();
  if (prior !== gl.NO_ERROR) throw new Error(`Water ${label}: pre-existing GL error ${prior}`);
  action();
  if (gl.isContextLost()) throw new Error(`Water ${label}: context lost during transfer`);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new Error(`Water ${label}: GL error ${error}`);
}

/** All nonzero storage/transfer work is called only after a shared quota debit. */
export class WaterFusionGPU {
  constructor(renderer, onContextChange) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.onLoss = () => onContextChange("lost");
    this.onRestore = () => onContextChange("restored");
    renderer.domElement?.addEventListener("webglcontextlost", this.onLoss);
    renderer.domElement?.addEventListener("webglcontextrestored", this.onRestore);
  }

  allocateTexture(r) {
    const t = new THREE.DataTexture(r.data, r.plan.width, r.plan.height, THREE.RGBAFormat, THREE.FloatType);
    t.internalFormat = "RGBA32F";
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = t.flipY = false;
    t.unpackAlignment = 1;
    // Allocate/zero storage now. Never let Three upload the entire CPU backing
    // implicitly on init or when a material first samples it.
    t.source.dataReady = false;
    t.needsUpdate = true;
    r.texture = t;
    checked(this.renderer, "texture allocation", () => this.renderer.initTexture(t));
    r.textureAllocated = true;
  }

  withBuffer(buffer, action) {
    const gl = this.gl, old = gl.getParameter(gl.COPY_WRITE_BUFFER_BINDING);
    try { gl.bindBuffer(gl.COPY_WRITE_BUFFER, buffer); action(); }
    finally { gl.bindBuffer(gl.COPY_WRITE_BUFFER, old); }
  }

  allocateBuffer(r, field, bytes) {
    const gl = this.gl;
    checked(this.renderer, `${field} allocation`, () => {
      r[field] = gl.createBuffer();
      if (!r[field]) throw new Error("Water buffer allocation returned null");
      if (field === "indexBuffer") {
        // WebGL permanently classifies a buffer on its FIRST bind. Starting on
        // COPY_WRITE makes it non-element data and later indexed draws fail.
        // Restore the current VAO's element binding without disturbing Three's
        // cached VAO selection. Subsequent updates may use COPY_WRITE.
        const previous = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
        try {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r[field]);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bytes, gl.STATIC_DRAW);
        } finally { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, previous); }
      } else {
        this.withBuffer(r[field], () => gl.bufferData(gl.COPY_WRITE_BUFFER, bytes, gl.STATIC_DRAW));
      }
    });
  }

  uploadBuffer(r, field, bytesOffset, source) {
    checked(this.renderer, `${field} upload`, () =>
      this.withBuffer(r[field], () => this.gl.bufferSubData(this.gl.COPY_WRITE_BUFFER, bytesOffset, source)));
  }

  uploadRows(r, first, count) {
    const gl = this.gl, handle = this.renderer.properties.get(r.texture).__webglTexture;
    if (!handle) throw new Error("Water texture has no GPU allocation");
    const target = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const names = [gl.UNPACK_ALIGNMENT, gl.UNPACK_ROW_LENGTH, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS,
      gl.UNPACK_IMAGE_HEIGHT, gl.UNPACK_SKIP_IMAGES, gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL];
    const values = names.map(name => gl.getParameter(name));
    checked(this.renderer, "row upload", () => {
      try {
        gl.bindTexture(gl.TEXTURE_2D, handle);
        names.forEach((name, i) => gl.pixelStorei(name, i ? 0 : 1));
        const width = r.plan.width, data = r.data.subarray(first * width * 4, (first + count) * width * 4);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, first, width, count, gl.RGBA, gl.FLOAT, data);
      } finally {
        names.forEach((name, i) => gl.pixelStorei(name, values[i]));
        gl.bindTexture(gl.TEXTURE_2D, target);
      }
    });
  }

  detachGeometry(r) {
    if (!r.drawGeometry || r.internalDispose) return;
    const internalDispose = r.internalDispose;
    r.internalDispose = true;
    // External GL buffers have exactly one deletion owner here. Removing the
    // attribute references before Three's dispose listener avoids double delete;
    // Three still drops the geometry's VAOs and its weak attribute-cache keys.
    r.drawGeometry.index = null;
    r.drawGeometry.attributes = {};
    try { r.drawGeometry.dispose(); } finally { r.internalDispose = internalDispose; }
  }

  releaseTexture(r) {
    const texture = r.texture;
    r.texture = null;
    r.textureAllocated = false;
    try { texture?.dispose(); } finally { if (texture) texture.image.data = null; }
  }

  releaseBuffer(r, field) {
    const buffer = r[field];
    r[field] = null;
    if (buffer) this.gl.deleteBuffer(buffer);
  }

  reset(r) {
    // Capture this generation before callbacks. Never delete a replacement
    // installed reentrantly in one of these slots, and finish all retirements
    // even if a user dispose listener throws.
    const texture = r.texture, index = r.indexBuffer, vbo = r.vbo, material = r.material;
    r.texture = null; r.textureAllocated = false;
    r.indexBuffer = r.vbo = null;
    r.material = null;
    let failure;
    for (const dispose of [
      () => this.detachGeometry(r),
      () => { try { texture?.dispose(); } finally { if (texture) texture.image.data = null; } },
      () => { if (index) this.gl.deleteBuffer(index); },
      () => { if (vbo) this.gl.deleteBuffer(vbo); },
      () => material?.dispose(),
    ]) {
      try { dispose(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }

  dispose() {
    this.renderer.domElement?.removeEventListener("webglcontextlost", this.onLoss);
    this.renderer.domElement?.removeEventListener("webglcontextrestored", this.onRestore);
  }
}
