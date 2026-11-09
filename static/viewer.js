// 3D viewport: renders the discrete model with per-element colours and does
// GPU (ID-buffer) picking so selection is exact, occlusion-aware and O(1) per click.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PICK_VS = /* glsl */`
  attribute float elemId;
  varying float vId;
  void main() {
    vId = elemId;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const PICK_FS = /* glsl */`
  varying float vId;
  void main() {
    float id = floor(vId + 0.5) + 1.0;
    float r = mod(id, 256.0);
    float g = mod(floor(id / 256.0), 256.0);
    float b = floor(id / 65536.0);
    gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
  }`;

// vertex colours are interpreted as linear by three.js; palettes are authored in sRGB
const SRGB_TO_LINEAR = new Uint8Array(256).map((_, i) => {
  const c = i / 255;
  return Math.round(255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
});

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(10, -10, 8);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    const hemi = new THREE.HemisphereLight(0xf2f4ff, 0x40382f, 1.4);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.camera.add(this.headlight);
    this.headlight.position.set(0.4, 0.6, 1);
    this.scene.add(this.camera);

    this.grid = new THREE.GridHelper(20, 20, 0x666a73, 0x3a3d44);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(1);
    this.scene.add(this.axes);

    this.pickScene = new THREE.Scene();
    this.pickMaterial = new THREE.ShaderMaterial({
      vertexShader: PICK_VS, fragmentShader: PICK_FS, side: THREE.DoubleSide,
    });
    this.pick1 = new THREE.WebGLRenderTarget(1, 1);
    this.pickFull = new THREE.WebGLRenderTarget(1, 1);
    this.pickBuf = new Uint8Array(4);

    this.mesh = null;
    this._renderQueued = false;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  setBackground(css) { this.renderer.setClearColor(new THREE.Color(css), 1); this.requestRender(); }

  /**
   * positions: Float32Array(N*3); renderTris: Uint32Array(R*3) vertex indices;
   * triElem: Uint32Array(R) element index for each render triangle.
   */
  setMesh(positions, renderTris, triElem, nElem) {
    this.clearMesh();
    const R = triElem.length;
    const pos = new Float32Array(R * 9);
    const eid = new Float32Array(R * 3);
    for (let r = 0; r < R; r++) {
      for (let k = 0; k < 3; k++) {
        const v = renderTris[r * 3 + k];
        pos[r * 9 + k * 3] = positions[v * 3];
        pos[r * 9 + k * 3 + 1] = positions[v * 3 + 1];
        pos[r * 9 + k * 3 + 2] = positions[v * 3 + 2];
        eid[r * 3 + k] = triElem[r];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('elemId', new THREE.BufferAttribute(eid, 1));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(R * 9), 3, true));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.geometry = g;
    this.triElem = triElem;
    this.nElem = nElem;

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.scene.add(this.mesh);
    this.wire = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0x000000, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false,
    }));
    this.wire.visible = false;
    this.scene.add(this.wire);
    this.pickMesh = new THREE.Mesh(g, this.pickMaterial);
    this.pickScene.add(this.pickMesh);

    // ground grid sized to the model footprint
    const bb = g.boundingBox, size = new THREE.Vector3();
    bb.getSize(size);
    const span = Math.max(size.x, size.y, size.z, 1e-3);
    const step = Math.pow(10, Math.floor(Math.log10(span / 2)));
    const half = Math.ceil(Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.y), Math.abs(bb.max.y)) / step + 1) * step;
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(half * 2, Math.round(half * 2 / step), 0x6b7080, 0x3a3d46);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = bb.min.z;
    this.scene.add(this.grid);
    this.axes.scale.setScalar(span * 0.12);
    this.camera.near = span / 2000;
    this.camera.far = span * 100;
    this.camera.updateProjectionMatrix();
    this.frameBox(bb, true);
  }

  clearMesh() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh, this.wire);
    this.pickScene.remove(this.pickMesh);
    this.geometry.dispose();
    this.material.dispose();
    this.wire.material.dispose();
    this.mesh = null;
  }

  /** rgb: Uint8Array(nElem*3), sRGB bytes */
  setElementColors(rgb) {
    if (!this.mesh) return;
    const col = this.geometry.attributes.color.array, te = this.triElem, L = SRGB_TO_LINEAR;
    for (let r = 0, R = te.length; r < R; r++) {
      const e = te[r] * 3, o = r * 9;
      const cr = L[rgb[e]], cg = L[rgb[e + 1]], cb = L[rgb[e + 2]];
      col[o] = col[o + 3] = col[o + 6] = cr;
      col[o + 1] = col[o + 4] = col[o + 7] = cg;
      col[o + 2] = col[o + 5] = col[o + 8] = cb;
    }
    this.geometry.attributes.color.needsUpdate = true;
    this.requestRender();
  }

  /** visible: Uint8Array(nElem), 1 = shown */
  setVisibility(visible) {
    if (!this.mesh) return;
    const te = this.triElem;
    let n = 0;
    for (let r = 0; r < te.length; r++) if (visible[te[r]]) n++;
    const idx = new Uint32Array(n * 3);
    let j = 0;
    for (let r = 0; r < te.length; r++) {
      if (visible[te[r]]) { idx[j++] = r * 3; idx[j++] = r * 3 + 1; idx[j++] = r * 3 + 2; }
    }
    const attr = new THREE.BufferAttribute(idx, 1);
    // three caches the wireframe index keyed on index.version; keep it increasing
    attr.version = this._idxVersion = (this._idxVersion || 0) + 1;
    this.geometry.setIndex(attr);
    this.requestRender();
  }

  setWireframe(on) { if (this.wire) { this.wire.visible = on; this.requestRender(); } }
  setGridVisible(on) { this.grid.visible = on; this.axes.visible = on; this.requestRender(); }

  _renderPick(target) {
    const r = this.renderer, prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.pickScene, this.camera);
    r.setRenderTarget(null);
    r.setClearColor(prevClear, prevAlpha);
  }

  /** Element index under a canvas-relative CSS pixel, or -1. */
  pickAt(x, y) {
    if (!this.mesh) return -1;
    const dpr = this.renderer.getPixelRatio();
    const W = this.canvas.width, H = this.canvas.height;
    this.camera.setViewOffset(W, H, Math.floor(x * dpr), Math.floor(y * dpr), 1, 1);
    this._renderPick(this.pick1);
    this.camera.clearViewOffset();
    this.renderer.readRenderTargetPixels(this.pick1, 0, 0, 1, 1, this.pickBuf);
    const b = this.pickBuf;
    return b[0] + b[1] * 256 + b[2] * 65536 - 1;
  }

  /** Visible elements whose pixels fall inside a CSS-pixel rectangle. Returns Set. */
  pickRectVisible(x0, y0, x1, y1) {
    const out = new Set();
    if (!this.mesh) return out;
    const dpr = this.renderer.getPixelRatio();
    const W = this.canvas.width, H = this.canvas.height;
    if (this.pickFull.width !== W || this.pickFull.height !== H) this.pickFull.setSize(W, H);
    this._renderPick(this.pickFull);
    const px0 = Math.max(0, Math.floor(Math.min(x0, x1) * dpr)), px1 = Math.min(W, Math.ceil(Math.max(x0, x1) * dpr));
    const py0 = Math.max(0, Math.floor(Math.min(y0, y1) * dpr)), py1 = Math.min(H, Math.ceil(Math.max(y0, y1) * dpr));
    const w = px1 - px0, h = py1 - py0;
    if (w <= 0 || h <= 0) return out;
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(this.pickFull, px0, H - py1, w, h, buf);
    for (let i = 0; i < buf.length; i += 4) {
      const id = buf[i] + buf[i + 1] * 256 + buf[i + 2] * 65536 - 1;
      if (id >= 0) out.add(id);
    }
    return out;
  }

  /** Elements whose centroid projects inside the rectangle (selects through the model). */
  pickRectThrough(x0, y0, x1, y1, centroids, visible) {
    const out = [];
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const W = this.container.clientWidth, H = this.container.clientHeight;
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const n = centroids.length / 3;
    for (let e = 0; e < n; e++) {
      if (!visible[e]) continue;
      const x = centroids[e * 3], y = centroids[e * 3 + 1], z = centroids[e * 3 + 2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 0) continue;
      const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * W;
      const sy = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5) * H;
      if (sx >= ax && sx <= bx && sy >= ay && sy <= by) out.push(e);
    }
    return out;
  }

  frameBox(box, resetDirection = false) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-4);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    let dir;
    if (resetDirection) dir = new THREE.Vector3(1, -1.4, 0.7).normalize();
    else dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.controls.update();
    this.requestRender();
  }

  setView(name) {
    if (!this.mesh) return;
    const dirs = {
      front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
      top: [0, -0.0001, 1], iso: [1, -1.4, 0.7],
    };
    const bb = this.geometry.boundingBox;
    const d = new THREE.Vector3(...dirs[name]).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(d, 1);
    this.frameBox(bb, false);
  }

  screenshot() { this.renderer.render(this.scene, this.camera); return this.canvas.toDataURL('image/png'); }
}
