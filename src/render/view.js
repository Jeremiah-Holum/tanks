// The three.js view of a world. Reads sim state, never changes rules.
//
// Contract (main.js / ui.js code against this):
//   new View(canvas, quality)  setQuality(name)  resize()  buildBoard(world)  — any map size
//   sync(world, alpha, dt, focusTank, aimYaw, seen)   seen: Set of tank ids the player's team sees
//   consume(world)            reads world.events (never clears them)
//   render(dt, time)   setAimLine(from, to)  hideAim()   (from/to are sim coords {x,z})
//   screenToBoard(px, py) → {x,z}|null   screenAxes()   boardToScreen(x, z, y) → {x,y,behind}
//   tankScreenAnchor(tank) → {x, y, behind, visible}   (screen point just above a tank)
//   mode: 'chase'|'tactical'|'orbit'   cam.snap   cam.introT   shake   onSound(kind, info)
//   tacZoom: 0 (close, follows the player) … 1 (whole board) for the tactical camera
//
// onSound kinds and info:
//   fire {x,z,rocket,cls,mine: fired by the human}   impact {x,z,surface: 'wood'|'paper'|'metal'|'plastic'|'stone'|'card'|'frame'}
//   ricochet / pen / nopen {x,z,tank,by,you: target is human,yours: shooter is human,dmg,module}
//   boom {x,z,big,human,ammo}   crate {x,z}   mine {x,z}   trip {}   clash {x,z}   dud {}   burn {x,z,tank,you}
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CELL, MINE_FUSE, sightClear } from '../sim/world.js';
import * as M from './models.js';
import * as TX from './textures.js';
import { FX } from './fx.js';
import { Post } from './post.js';
import { buildProps, breakCrate, SURF } from './props.js';

// Board origin: sim (x, z) → view (x - OX, z - OZ). Updated by buildBoard for each world size.
let OX = 22, OZ = 16;
export const toView = (x, z) => [x - OX, z - OZ];
const FLOOR_Y = -0.36;
const SURF_NAME = ['frame', 'wood', 'paper', 'metal', 'plastic', 'stone', 'card'];

export const QUALITY = {
  low:    { name: 'low',    msaa: 0, shadow: 2048, dof: false, bloom: false, motes: false, grass: 0.3, pr: 0.85 },
  medium: { name: 'medium', msaa: 4, shadow: 2048, dof: true,  bloom: true,  motes: true,  grass: 0.7, pr: 1.0 },
  high:   { name: 'high',   msaa: 4, shadow: 4096, dof: true,  bloom: true,  motes: true,  grass: 1.0, pr: 1.5 },
};

const AIM_VERT = /* glsl */`
  uniform vec3 uFrom; uniform vec3 uTo; uniform float uWidth;
  varying vec2 vAb; varying float vLen;
  void main() {
    vec3 d = uTo - uFrom; vLen = length(d);
    vec3 dir = d / max(vLen, 1e-4);
    vec3 p = uFrom + d * position.x;
    vec3 toCam = normalize(cameraPosition - p);
    vec3 side = normalize(cross(dir, toCam));
    // keep the ribbon a constant screen-ish width: a touch wider far away
    float w = uWidth * (1.0 + 0.035 * distance(cameraPosition, p));
    p += side * position.y * w;
    vAb = position.xy;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;
const AIM_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uOpacity;
  varying vec2 vAb; varying float vLen;
  void main() {
    float along = vAb.x * vLen;
    float a = smoothstep(0.0, 0.5, along) * (1.0 - smoothstep(vLen * 0.55, vLen, along) * 0.8);
    a *= 1.0 - smoothstep(0.35, 1.0, abs(vAb.y));
    gl_FragColor = vec4(uColor, uOpacity * a);
  }`;

export class View {
  constructor(canvas, qualityName = 'high') {
    this.canvas = canvas;
    this.quality = { ...(QUALITY[qualityName] || QUALITY.high) };
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.NoToneMapping;
    r.info.autoReset = false;
    this.stats = { calls: 0, triangles: 0 };
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a130d);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 400);
    this.post = new Post(r, this.quality);
    this.fx = new FX(this.scene, this.quality);
    this.tankObjs = new Map(); this.shellObjs = new Map(); this.mineObjs = new Map();
    this.boardGroup = null; this.roomGroup = null;
    this.cols = 0; this.rows = 0; this.grid = null;
    this.shake = 0; this.flash = 0;
    this.mode = 'chase'; // 'chase' | 'tactical' | 'orbit'
    this.tacZoom = 0;
    this.cam = { introT: 1, blend: 1, pos: new THREE.Vector3(0, 30, 30), look: new THREE.Vector3(), yaw: 0, lastMode: 'chase', snap: false };
    this.onSound = () => {};
    this._time = 0;
    this._buildLights();
    this._buildAim();
    this._envDirty = true;
    this._setDims(22, 16);
    this._buildRoom();
    this.setQuality(this.quality.name);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(name) {
    const q = QUALITY[name] || QUALITY.high;
    Object.assign(this.quality, q);
    this.key.shadow.mapSize.set(q.shadow, q.shadow);
    if (this.key.shadow.map) { this.key.shadow.map.dispose(); this.key.shadow.map = null; }
    this.post.sceneRT.samples = q.msaa;
    if (this.grass) this.grass.count = Math.floor(this.grassTotal * q.grass);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pr);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(Math.floor(w * pr), Math.floor(h * pr));
    this.camera.aspect = w / h;
    this._fitWhole();
  }

  _setDims(cols, rows) {
    this.cols = cols; this.rows = rows;
    OX = cols / 2; OZ = rows / 2;
    this.OX = OX; this.OZ = OZ;
  }

  // ------------------------------------------------------------ lights
  _buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xcfdcff, 0x5a4030, 0.3));
    // sunlight through the window on the back wall
    const key = this.key = new THREE.DirectionalLight(0xffe2b8, 2.7);
    key.castShadow = true;
    key.shadow.bias = -0.0002; key.shadow.normalBias = 0.02;
    s.add(key); s.add(key.target);
    const fill = this.fill = new THREE.DirectionalLight(0x9fb6ff, 0.5); fill.position.set(14, 10, 18); s.add(fill);
    this.lamp = new THREE.PointLight(0xffc98a, 160, 140, 1.6); s.add(this.lamp);
  }

  // Aim the sun and fit its shadow camera tightly around the board (and its tall toys).
  _fitShadow() {
    const key = this.key;
    const dir = new THREE.Vector3(-9, 20, -16).normalize();
    key.position.copy(dir).multiplyScalar(60); key.target.position.set(0, 0, 0);
    key.updateMatrixWorld(); key.target.updateMatrixWorld();
    const view = new THREE.Matrix4().lookAt(key.position, key.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(key.position); view.invert();
    const hx = OX + 1.2, hz = OZ + 1.2;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const v = new THREE.Vector3();
    for (const x of [-hx, hx]) for (const y of [FLOOR_Y, 3.4]) for (const z of [-hz, hz]) {
      v.set(x, y, z).applyMatrix4(view);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z);
    }
    const sc = key.shadow.camera;
    sc.left = x0; sc.right = x1; sc.bottom = y0; sc.top = y1; sc.near = Math.max(0.5, -z1 - 2); sc.far = -z0 + 2;
    sc.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ the bedroom (sized to the board)
  _buildRoom() {
    if (this.roomGroup) {
      this.scene.remove(this.roomGroup);
      this.roomGroup.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } });
    }
    const s = this.roomGroup = new THREE.Group();
    this.scene.add(s);
    const T = 0.7, H = 0.95;
    const bx = OX + T, bz = OZ + T;
    const RW = bx + 28, RD = bz + 18, RH = 46;
    this.room = { RW, RD, RH, bx, bz };
    this.lamp.position.set(RW * 0.15, FLOOR_Y + RH - 8, RD * 0.25);
    this._fitShadow();

    // floor (hardwood) + rug under the diorama
    const wf = this._wf || (this._wf = TX.woodFloor());
    wf.map.repeat.set(RW / 9, RD / 9); wf.rough.repeat.set(RW / 9, RD / 9);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(RW * 2, RD * 2), new THREE.MeshStandardMaterial({ map: wf.map, roughnessMap: wf.rough, roughness: 0.5, envMapIntensity: 0.5 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR_Y - 0.02; floor.receiveShadow = true; s.add(floor);
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(bx * 2 + 14, bz * 2 + 11), new THREE.MeshStandardMaterial({ map: this._rug || (this._rug = TX.rug()), roughness: 0.95 }));
    rug.rotation.x = -Math.PI / 2; rug.position.y = FLOOR_Y - 0.005; rug.receiveShadow = true; s.add(rug);

    // walls with wallpaper, skirting, ceiling
    const wp = this._wp || (this._wp = TX.wallpaper());
    wp.repeat.set(RW / 7, 3);
    const wallMat = new THREE.MeshStandardMaterial({ map: wp, roughness: 0.9 });
    const wall = (w, x, z, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, RH), wallMat); m.position.set(x, FLOOR_Y + RH / 2, z); m.rotation.y = ry; m.receiveShadow = true; s.add(m); };
    wall(RW * 2, 0, -RD, 0); wall(RW * 2, 0, RD, Math.PI); wall(RD * 2, -RW, 0, Math.PI / 2); wall(RD * 2, RW, 0, -Math.PI / 2);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(RW * 2, RD * 2), new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 1 }));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = FLOOR_Y + RH; s.add(ceil);
    const skirt = new THREE.MeshStandardMaterial({ color: 0xf2eee6, roughness: 0.5 });
    for (const [w, x, z, ry] of [[RW * 2, 0, -RD + 0.3, 0], [RW * 2, 0, RD - 0.3, Math.PI], [RD * 2, -RW + 0.3, 0, Math.PI / 2], [RD * 2, RW - 0.3, 0, -Math.PI / 2]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, 1.8, 0.6), skirt); b.position.set(x, FLOOR_Y + 0.9, z); b.rotation.y = ry; s.add(b);
    }
    // window: bright pane (blooms), frame, sill — behind the board, where the sun comes from
    const win = new THREE.Group();
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(18, 15), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.0, 2.6) }));
    win.add(pane);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xf6f3ee, roughness: 0.4 });
    for (const [w, h, x, y] of [[19, 0.9, 0, 7.6], [19, 0.9, 0, -7.6], [0.9, 16, -9.2, 0], [0.9, 16, 9.2, 0], [0.5, 15, 0, 0], [18, 0.5, 0, 0]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.6), frameMat); b.position.set(x, y, 0.3); win.add(b);
    }
    const sill = new THREE.Mesh(new THREE.BoxGeometry(20, 0.6, 2.2), frameMat); sill.position.set(0, -8.1, 1.1); win.add(sill);
    // curtains
    const curtain = new THREE.MeshStandardMaterial({ color: 0xc9d6e8, roughness: 0.95, side: THREE.DoubleSide });
    for (const sd of [-1, 1]) {
      const cg = new THREE.PlaneGeometry(5, 19, 24, 1);
      const p = cg.attributes.position;
      for (let k = 0; k < p.count; k++) p.setZ(k, Math.sin(p.getX(k) * 2.4) * 0.35 + 0.5);
      cg.computeVertexNormals();
      const c = new THREE.Mesh(cg, curtain); c.position.set(sd * 11.6, -0.5, 0.4); c.castShadow = true; win.add(c);
    }
    win.position.set(-bx * 0.35, FLOOR_Y + 22, -RD + 0.05); s.add(win);
    // door on the right wall
    const door = new THREE.Group();
    const dwood = new THREE.MeshStandardMaterial({ color: 0xf2eee6, roughness: 0.45 });
    const dp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 38, 16), dwood); dp.position.y = 19; door.add(dp);
    for (const [y, h] of [[28, 12], [10, 14]]) for (const z of [-3.6, 3.6]) { const pnl = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, 5.4), new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.5 })); pnl.position.set(-0.25, y, z); door.add(pnl); }
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 12), new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 1, roughness: 0.3 })); knob.position.set(-0.8, 18, -6); door.add(knob);
    for (const [w, h, y, z] of [[1.2, 40, 19.5, -8.6], [1.2, 40, 19.5, 8.6], [1.2, 1.2, 39.2, 0]]) { const fr = new THREE.Mesh(new THREE.BoxGeometry(0.8, h, w === 1.2 && h === 1.2 ? 18.4 : 1.2), dwood); fr.position.set(-0.2, y, z); door.add(fr); }
    door.position.set(RW - 0.3, FLOOR_Y, RD * 0.35); s.add(door);
    // a child's drawing of a tank pinned to the wall, and a poster
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), new THREE.MeshStandardMaterial({ map: this._draw || (this._draw = drawingTexture()), roughness: 0.9 }));
    pic.position.set(bx * 0.45, FLOOR_Y + 21, -RD + 0.08); pic.rotation.z = 0.04; s.add(pic);

    // furniture
    const bed = M.bed(); bed.position.set(-RW + 11, FLOOR_Y, -RD + 22); s.add(bed);
    const shelf = M.bookshelf(); shelf.position.set(RW - 10, FLOOR_Y, -RD + 3); s.add(shelf);
    const chest = M.toyChest(); chest.position.set(bx * 0.05 + 6, FLOOR_Y, -RD + 5.2); chest.rotation.y = -0.06; s.add(chest);
    // soft contact shadows under the furniture (the sun's shadow map only covers the board)
    const blob = this._blobTex || (this._blobTex = TX.blobShadow());
    const under = (w, d, x, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false, opacity: 0.7 })); m.position.set(x, FLOOR_Y + 0.01, z); s.add(m); };
    under(26, 46, -RW + 11, -RD + 22); under(20, 8, RW - 10, -RD + 3.5); under(18, 12, bx * 0.05 + 6, -RD + 5.2);

    // toys scattered on the rug around the diorama (they blur out; they sell the scale)
    const P = [];
    const L = -bx - 3.4, Rr = bx + 3.6, F = bz + 3.4;
    const pen = M.pencil(0xf2c230); pen.position.set(L - 0.4, FLOOR_Y + 0.42, bz * 0.15); pen.rotation.y = 1.25; P.push(pen);
    const pen2 = M.pencil(0x2c6fd6); pen2.position.set(Rr + 0.6, FLOOR_Y + 0.42, -bz * 0.3); pen2.rotation.y = -1.9; P.push(pen2);
    [0xd93b30, 0x3aa35b, 0x7c4ec4, 0xf07f2a].forEach((c, k) => { const cr = M.crayon(c); cr.position.set(Rr + 1.4 + k * 0.4, FLOOR_Y + 0.5, bz * 0.25 + k * 1.15); cr.rotation.y = -0.35 + k * 0.12; P.push(cr); });
    const mg = M.mug(); mg.position.set(L - 3, FLOOR_Y, -bz * 0.45); P.push(mg);
    const b1 = M.brick(0xd93b30, 4, 2); b1.position.set(L, FLOOR_Y, bz * 0.62); b1.rotation.y = 0.4; P.push(b1);
    const b2 = M.brick(0x2c6fd6, 2, 2); b2.position.set(L + 1.2, FLOOR_Y + 0.96, bz * 0.62 + 0.6); b2.rotation.y = 0.9; P.push(b2);
    const b3 = M.brick(0xf0b62a, 3, 2); b3.position.set(Rr, FLOOR_Y, bz * 0.66); b3.rotation.y = -0.3; P.push(b3);
    for (let k = 0; k < 5; k++) { const so = M.toySoldier(); so.position.set(L - 1 + (k % 3) * 1.1, FLOOR_Y, -bz * 0.1 + Math.floor(k / 3) * 1.3 + (k % 2) * 0.5); so.rotation.y = 0.8 + k * 0.4; so.scale.setScalar(0.62); P.push(so); }
    const b4 = M.brick(0x3aa35b, 2, 4); b4.position.set(bx * 0.4, FLOOR_Y, -bz - 3.2); b4.rotation.y = 0.2; P.push(b4);
    const b5 = M.brick(0xe8dcc0, 4, 2); b5.position.set(-bx * 0.3, FLOOR_Y, -bz - 3.0); b5.rotation.y = -0.15; P.push(b5);
    const b6 = M.brick(0xd93b30, 2, 2); b6.position.set(bx * 0.2, FLOOR_Y, F + 1); b6.rotation.y = 0.5; P.push(b6);
    for (const p of P) s.add(p);

    // diorama tray (walnut) around the board
    const wal = this._wal || (this._wal = TX.walnut());
    const frameW = new THREE.MeshPhysicalMaterial({ map: wal, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.5 });
    const mk = (w, d, x, z) => { const m = new THREE.Mesh(new RoundedBoxGeometry(w, H, d, 3, 0.08), frameW); m.position.set(x, FLOOR_Y + H / 2, z); m.castShadow = true; m.receiveShadow = true; s.add(m); };
    mk(this.cols + T * 2, T, 0, -OZ - T / 2); mk(this.cols + T * 2, T, 0, OZ + T / 2);
    mk(T, this.rows, -OX - T / 2, 0); mk(T, this.rows, OX + T / 2, 0);
    const brass = new THREE.MeshStandardMaterial({ color: 0xb8913f, metalness: 1, roughness: 0.62 });
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const c = new THREE.Mesh(new RoundedBoxGeometry(T + 0.06, 0.2, T + 0.06, 2, 0.05), brass);
      c.position.set(x * (OX + T / 2), FLOOR_Y + H + 0.02, z * (OZ + T / 2)); c.castShadow = true; s.add(c);
    }
    const plate = new THREE.Mesh(new RoundedBoxGeometry(3.2, 0.5, 0.05, 2, 0.02), brass);
    plate.position.set(0, FLOOR_Y + 0.5, OZ + T + 0.01); s.add(plate);
    mergeStatic(s);
    this.fx.setBounds(OX, OZ);
    this.post.cocMat.uniforms.boardHalf.value.set(OX + 0.9, OZ + 0.9);
    this._envDirty = true;
  }

  // Reflections come from this actual room, captured once from above the board.
  _captureEnv() {
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cc = new THREE.CubeCamera(0.1, 300, cubeRT);
    cc.position.set(0, 3, 0);
    this.scene.add(cc);
    const vis = [];
    this.scene.traverse((o) => { if (o.isPoints || (o.isMesh && o.material && o.material.blending === THREE.AdditiveBlending)) { vis.push([o, o.visible]); o.visible = false; } });
    cc.update(this.renderer, this.scene);
    for (const [o, v] of vis) o.visible = v;
    const pm = new THREE.PMREMGenerator(this.renderer);
    const env = pm.fromCubemap(cubeRT.texture).texture;
    if (this.scene.environment) this.scene.environment.dispose();
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.55;
    this.scene.remove(cc); cubeRT.dispose(); pm.dispose();
    this._envDirty = false;
  }

  // ------------------------------------------------------------ board
  buildBoard(world) {
    if (this.boardGroup) {
      this.scene.remove(this.boardGroup);
      this.boardGroup.traverse((o) => { if (o.isMesh && o.userData.own) o.geometry.dispose(); });
    }
    for (const [, o] of this.tankObjs) this._dropTank(o);
    for (const [, o] of this.shellObjs) this.scene.remove(o);
    for (const [, o] of this.mineObjs) this.scene.remove(o);
    this.tankObjs.clear(); this.shellObjs.clear(); this.mineObjs.clear();
    this.fx.clearLevel();

    const grid = world.grid;
    const C = grid.cols || world.cols, R = grid.rows || world.rows;
    const resized = C !== this.cols || R !== this.rows || !this.roomGroup;
    this._setDims(C, R);
    if (resized) { this._buildRoom(); this._fitWhole(); }
    this.grid = grid;
    const g = this.boardGroup = new THREE.Group();
    this.scene.add(g);

    const tkey = C + 'x' + R;
    if (!this.terrain || this.terrain.key !== tkey) {
      if (this.terrain) { this.terrain.map.dispose(); this.terrain.rough.dispose(); }
      this.terrain = TX.diorama(C, R); this.terrain.key = tkey;
      if (this.grain) this.grain.dispose();
      this.grain = TX.grainNormal(512, [C, R]);
    }
    // board top: one quad per non-pit cell
    const pos = [], uv = [], nrm = [], idx = [];
    const quad = (x0, z0, x1, z1) => {
      const b = pos.length / 3;
      pos.push(x0 - OX, 0, z0 - OZ, x1 - OX, 0, z0 - OZ, x1 - OX, 0, z1 - OZ, x0 - OX, 0, z1 - OZ);
      uv.push(x0 / C, 1 - z0 / R, x1 / C, 1 - z0 / R, x1 / C, 1 - z1 / R, x0 / C, 1 - z1 / R);
      nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    };
    for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) if (grid[j * C + i] !== CELL.PIT) quad(i, j, i + 1, j + 1);
    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    top.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    top.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    top.setIndex(idx);
    const board = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ map: this.terrain.map, roughnessMap: this.terrain.rough, normalMap: this.grain, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 1, envMapIntensity: 0.35 }));
    board.receiveShadow = true; board.userData.own = true;
    g.add(board);
    // pits: shell-crater holes with earthy walls, merged into two meshes
    const wallP = [], wallN = [], botP = [];
    let anyPit = false;
    for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) {
      if (grid[j * C + i] !== CELL.PIT) continue;
      anyPit = true;
      const x0 = i - OX, z0 = j - OZ, x1 = x0 + 1, z1 = z0 + 1, yb = -1.2;
      botP.push(x0, yb, z0, x0, yb, z1, x1, yb, z1, x0, yb, z0, x1, yb, z1, x1, yb, z0);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni >= 0 && nj >= 0 && ni < C && nj < R && grid[nj * C + ni] === CELL.PIT) continue;
        // inward-facing wall on that edge
        let a, b;
        if (di === 1) { a = [x1, z0]; b = [x1, z1]; } else if (di === -1) { a = [x0, z1]; b = [x0, z0]; } else if (dj === 1) { a = [x1, z1]; b = [x0, z1]; } else { a = [x0, z0]; b = [x1, z0]; }
        wallP.push(a[0], 0, a[1], a[0], yb, a[1], b[0], yb, b[1], a[0], 0, a[1], b[0], yb, b[1], b[0], 0, b[1]);
        for (let k = 0; k < 6; k++) wallN.push(-di, 0, -dj);
      }
    }
    if (anyPit) {
      const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wallP, 3)); wg.setAttribute('normal', new THREE.Float32BufferAttribute(wallN, 3));
      const wm = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 0.95, side: THREE.DoubleSide })); wm.receiveShadow = true; wm.userData.own = true; g.add(wm);
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(botP, 3)); bg.computeVertexNormals();
      const bm = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ color: 0x0b0806, roughness: 1, side: THREE.DoubleSide })); bm.userData.own = true; g.add(bm);
    } else {
      const under = new THREE.Mesh(new THREE.BoxGeometry(C, 0.34, R), new THREE.MeshStandardMaterial({ color: 0x5a3e24, roughness: 0.9 }));
      under.position.y = -0.18; under.userData.own = true; g.add(under);
    }
    // tall toy obstacles
    const props = this.props = buildProps(world, OX, OZ);
    g.add(props.group);
    // 3D grass flock on open ground, following the painted grass patches
    let h = 7 + (world.levelIndex || 0) * 13 + C * 31;
    const rnd = () => { h = (h * 16807) % 2147483647; return h / 2147483647; };
    const tuftGeo = this._tuftGeo || (this._tuftGeo = (() => { const a = new THREE.PlaneGeometry(0.16, 0.1); a.translate(0, 0.05, 0); const b = a.clone().rotateY(Math.PI / 2); const c2 = a.clone().rotateY(Math.PI / 4); const d = a.clone().rotateY(-Math.PI / 4); return mergeSimple([a, b, c2, d]); })());
    const tuftMat = this._tuftMat || (this._tuftMat = new THREE.MeshStandardMaterial({ map: TX.grassCard(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 }));
    const MAXT = Math.min(12000, Math.round(C * R * 7.5));
    const grass = new THREE.InstancedMesh(tuftGeo, tuftMat, MAXT);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (let k = 0; k < MAXT * 3.5 && n < MAXT; k++) {
      const x = rnd() * C, z = rnd() * R;
      if (grid[Math.floor(z) * C + Math.floor(x)] !== CELL.FLOOR) continue;
      const gm = this.terrain.grassAt(x, z);
      if (gm < 0.35 || rnd() > gm) continue;
      const sc = 0.45 + rnd() * 0.5;
      mtx.compose(pv.set(x - OX, 0, z - OZ), q.setFromAxisAngle(up, rnd() * 6.28), sv.set(sc, sc * (0.8 + rnd() * 0.5), sc));
      grass.setMatrixAt(n++, mtx);
    }
    this.grassTotal = n; grass.count = Math.floor(n * this.quality.grass);
    grass.receiveShadow = true;
    g.add(grass); this.grass = grass;
    this.cam.introT = 0;
    this._envDirty = true;
    this._fitWhole();
  }

  // Top of whatever is standing in the cell under view point (vx, vz): debris lands on it.
  solidTop = (vx, vz) => {
    const i = Math.floor(vx + OX), j = Math.floor(vz + OZ);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return 0.6;
    const k = j * this.cols + i, c = this.grid ? this.grid[k] : 0;
    if (c === CELL.PIT) return -1.2;
    if (c === CELL.FLOOR) return 0;
    return this.props ? this.props.height[k] || 0.94 : 0.94;
  };

  // ------------------------------------------------------------ aim line
  _buildAim() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aimMat = new THREE.ShaderMaterial({
      uniforms: { uFrom: { value: new THREE.Vector3() }, uTo: { value: new THREE.Vector3(1, 0, 0) }, uWidth: { value: 0.011 }, uColor: { value: new THREE.Color(1.5, 1.38, 1.15) }, uOpacity: { value: 0.55 } },
      vertexShader: AIM_VERT, fragmentShader: AIM_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.aimLine = new THREE.Mesh(g, this.aimMat);
    this.aimLine.frustumCulled = false; this.aimLine.renderOrder = 20; this.aimLine.visible = false;
    this.scene.add(this.aimLine);
  }
  // One thin straight line at barrel height from `from` to `to` (sim coords {x, z}).
  setAimLine(from, to) {
    if (!from || !to) { this.hideAim(); return; }
    const y = 0.4;
    this.aimMat.uniforms.uFrom.value.set(from.x - OX, y, from.z - OZ);
    this.aimMat.uniforms.uTo.value.set(to.x - OX, y, to.z - OZ);
    this.aimLine.visible = true;
  }
  // Deprecated (pre-Phase-B main.js): the old bounce path. Draws its first leg only.
  setAimPath(pts) { if (pts && pts.length > 1) this.setAimLine(pts[0], pts[pts.length - 1]); else this.hideAim(); }
  hideAim() { this.aimLine.visible = false; }

  // ------------------------------------------------------------ cameras
  _fitWhole() {
    const cam = this.camera;
    const elev = THREE.MathUtils.degToRad(57);
    const dir = new THREE.Vector3(0, Math.sin(elev), Math.cos(elev));
    const target = new THREE.Vector3(0, 0, 0.5);
    const hx = OX + 0.75, hz = OZ + 0.75;
    const pts = [[-hx, 0.6, -hz], [hx, 0.6, -hz], [-hx, 0.6, hz], [hx, 0.6, hz], [-hx, FLOOR_Y, hz], [hx, FLOOR_Y, hz]].map((p) => new THREE.Vector3(...p));
    const v = new THREE.Vector3();
    const savePos = cam.position.clone(), saveQ = cam.quaternion.clone(), saveFov = cam.fov;
    cam.fov = 32;
    let lo = 5, hi = 220;
    for (let it = 0; it < 30; it++) {
      const d = (lo + hi) / 2;
      cam.position.copy(target).addScaledVector(dir, d);
      cam.up.set(0, 1, 0); cam.lookAt(target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      let ok = true;
      for (const p of pts) { v.copy(p).project(cam); if (Math.abs(v.x) > 0.965 || Math.abs(v.y) > 0.9) { ok = false; break; } }
      if (ok) hi = d; else lo = d;
    }
    this.fit = { pos: target.clone().addScaledVector(dir, hi), look: target, dist: hi };
    this.tac = this.fit; // legacy name
    cam.position.copy(savePos); cam.quaternion.copy(saveQ); cam.fov = saveFov; cam.updateProjectionMatrix();
  }

  // Tactical: high and steep. On a small board it shows the whole thing; on a big one it
  // hangs over the player at a readable zoom (tacZoom 0) and slides out to the whole board
  // (tacZoom 1), clamped so it never looks far past the edge of the diorama.
  _tacticalPose(focus) {
    const elev = THREE.MathUtils.degToRad(60);
    const dir = new THREE.Vector3(0, Math.sin(elev), Math.cos(elev));
    const near = 25;
    const d = Math.min(this.fit.dist, near + (this.fit.dist - near) * this.tacZoom);
    if (d >= this.fit.dist * 0.97 || !focus) return { pos: this.fit.pos.clone(), look: this.fit.look.clone() };
    const t = Math.tan(THREE.MathUtils.degToRad(16));
    const halfW = d * t * this.camera.aspect, halfD = d * t / Math.sin(elev);
    const cx = Math.max(0, OX + 1 - halfW), cz = Math.max(0, OZ + 1 - halfD);
    const tx = THREE.MathUtils.clamp(focus.x - OX, -cx, cx), tz = THREE.MathUtils.clamp(focus.z - OZ + 0.5, -cz + 0.8, cz + 0.8);
    const look = new THREE.Vector3(tx, 0, tz);
    return { pos: look.clone().addScaledVector(dir, d), look };
  }

  // The chase rig: behind the turret, low, looking a few cells ahead.
  _chasePose(tank, aimYaw) {
    const [vx, vz] = toView(tank.x, tank.z);
    const fx = Math.cos(aimYaw), fz = Math.sin(aimYaw);
    // Low rig: the lens sits just over the turret, below the tops of the toys, so walls
    // genuinely hide what's behind them. Backed against a wall, it slides in.
    let back = 1.55;
    const height = 0.74;
    const C = this.cols, R = this.rows;
    for (let k = 0; k < 8; k++) {
      let blocked = false;
      for (let s = 0.3; s <= 1.001; s += 0.1) {
        const px = tank.x - fx * back * s, pz = tank.z - fz * back * s;
        const i = Math.floor(px), j = Math.floor(pz);
        const c = this.grid ? (i < 0 || j < 0 || i >= C || j >= R ? CELL.BLOCK : this.grid[j * C + i]) : 0;
        if (c === CELL.BLOCK || c === CELL.CRATE) { blocked = true; break; }
      }
      if (!blocked) break;
      back *= 0.82;
    }
    return {
      pos: new THREE.Vector3(vx - fx * back, height, vz - fz * back),
      look: new THREE.Vector3(vx + fx * 3.0, 0.42, vz + fz * 3.0),
    };
  }

  _updateCamera(dt, focus, aimYaw) {
    const c = this.cam, cam = this.camera;
    if (this.mode === 'free') { // tools: the camera is placed by hand
      cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      this.post.cocMat.uniforms.mode.value = 1; this.post.cocMat.uniforms.focus.value = this.freeFocus || 6;
      return;
    }
    c.introT = Math.min(1, c.introT + dt / 2.2);
    if (c.lastMode !== this.mode) { c.blend = 0; c.lastMode = this.mode; }
    c.blend = Math.min(1, c.blend + dt / 0.7);
    const chase = this.mode === 'chase' && focus && focus.alive;
    let want;
    if (this.mode === 'orbit') {
      const a = performance.now() / 1000 * 0.05;
      want = { pos: this.fit.pos.clone().multiplyScalar(0.92).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(a) * 0.5), look: new THREE.Vector3(0, 0, 0.6) };
    } else if (chase) {
      want = this._chasePose(focus, aimYaw);
    } else {
      want = this._tacticalPose(focus);
    }
    const fovWant = chase ? 62 : 32;
    cam.fov += (fovWant - cam.fov) * Math.min(1, dt * 4);
    // mission intro: start high over the whole diorama and swoop down into the pose
    const e = 1 - Math.pow(1 - c.introT, 3);
    if (e < 1) {
      const hi = this.fit.pos.clone().multiplyScalar(1.15).applyAxisAngle(new THREE.Vector3(0, 1, 0), (1 - e) * 0.9);
      want.pos = hi.lerp(want.pos, e);
      want.look = this.fit.look.clone().lerp(want.look, e);
    }
    const k = c.blend < 1 ? Math.min(1, dt * 6) : this.mode === 'chase' ? Math.min(1, dt * 10) : Math.min(1, dt * 5);
    const kk = c.snap ? 1 : k;
    c.pos.lerp(want.pos, e < 1 ? 1 : kk);
    c.look.lerp(want.look, e < 1 ? 1 : kk);
    if (c.snap) { cam.fov = fovWant; c.blend = 1; c.snap = false; }
    cam.position.copy(c.pos);
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const s = this.shake * this.shake * (this.mode === 'chase' ? 0.12 : 0.35), t = performance.now() / 1000;
    cam.position.x += Math.sin(t * 43.1) * s; cam.position.y += Math.sin(t * 37.7 + 1) * s * 0.6; cam.position.z += Math.sin(t * 51.3 + 2) * s;
    cam.up.set(0, 1, 0);
    cam.lookAt(c.look);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const cu = this.post.cocMat.uniforms;
    cu.mode.value = chase ? 1 : 0;
    cu.focus.value = cam.position.distanceTo(c.look);
  }

  screenToBoard(px, py) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.42);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x + OX, z: hit.z + OZ };
  }
  screenAxes() {
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0); right.y = 0; right.normalize();
    const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    return { rx: right.x, rz: right.z, ux: fwd.x, uz: fwd.z };
  }
  boardToScreen(x, z, y = 0.5) {
    const v = new THREE.Vector3(x - OX, y, z - OZ).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, behind: v.z > 1 };
  }
  // The screen point just above a tank, for HP bars. `visible` is false when it is off-screen,
  // behind the camera, fogged/invisible, dead, or (chase cam) hidden behind a toy.
  tankScreenAnchor(t) {
    const o = this.tankObjs.get(t.id);
    const sc = t.type.scale || 1;
    const p = o ? o.root.position : new THREE.Vector3(t.x - OX, 0, t.z - OZ);
    const top = o ? o.root.userData.spec.top : 0.52;
    const v = new THREE.Vector3(p.x, top * sc + 0.12, p.z).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    const behind = v.z > 1;
    const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
    let visible = t.alive && !behind && Math.abs(v.x) <= 1.02 && Math.abs(v.y) <= 1.02;
    if (visible && o && (!o.root.visible || o.vis < 0.5)) visible = false;
    if (visible && this.mode === 'chase' && this.grid) {
      const cx = this.camera.position.x + OX, cz = this.camera.position.z + OZ;
      if (Math.hypot(cx - t.x, cz - t.z) > 1.2 && !sightClear(this.grid, cx, cz, t.x, t.z)) visible = false;
    }
    return { x, y, behind, visible };
  }

  // ------------------------------------------------------------ tanks
  _tankObj(t) {
    let o = this.tankObjs.get(t.id);
    if (o) return o;
    const emblem = t.human ? 'star' : t.typeKey === 'boss' ? 'skull' : 'ring';
    const root = M.buildTank(t.type, { emblem, colorOverride: t.colorOverride });
    const sc = t.type.scale || 1;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.1 * sc, 0.85 * sc).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this._blob || (this._blob = TX.blobShadow()), transparent: true, depthWrite: false, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -1 }));
    this.scene.add(root); this.scene.add(shadow);
    o = { shadowCast: true, root, shadow, lastTread: t.tread, lastRot: t.rot, trackAcc: 0, vis: 1, reveal: 0, bob: 0, prevSpeed: 0, brokenSide: 0, jam: 0, wreckT: -1, fly: null, fireLight: -1 };
    this.tankObjs.set(t.id, o);
    return o;
  }
  _dropTank(o) {
    this.scene.remove(o.root); this.scene.remove(o.shadow);
    for (const m of o.root.userData.mats) m.dispose();
    o.shadow.geometry.dispose(); o.shadow.material.dispose();
  }
  // World point of a body-local point (x forward, y up) of tank `t` whose view pos is (vx, vz).
  _local(t, vx, vz, lx, ly, lz = 0) {
    const s = t.type.scale || 1, c = Math.cos(t.rot), sn = Math.sin(t.rot);
    return [vx + (lx * c - lz * sn) * s, ly * s, vz + (lx * sn + lz * c) * s];
  }

  sync(world, alpha, dt, focusTank, aimYaw, seen = null) {
    const now = performance.now();
    this._time += dt;
    let fireK = 0;
    for (const t of world.tanks) {
      const o = this._tankObj(t);
      const ud = o.root.userData;
      if (!t.alive) { this._syncWreck(t, o, dt); continue; }
      const x = t._rx != null ? t._rx + (t.x - t._rx) * alpha : t.x;
      const z = t._rz != null ? t._rz + (t.z - t._rz) * alpha : t.z;
      const [vx, vz] = toView(x, z);
      const sc = t.type.scale || 1;
      o.root.position.set(vx, 0, vz);
      o.shadow.position.set(vx, 0.003, vz); o.shadow.rotation.y = -t.rot;
      ud.body.rotation.y = -t.rot;
      ud.turret.rotation.y = -t.aim;
      ud.barrel.position.x = ud.barrelX - t.recoil * t.recoil * ud.spec.recoil;
      // tracks: straight travel moves both sides; turning in place counter-rotates them.
      // A tracked tank (modules.tracks > 0) throws a track: links drop, that side stops.
      const broken = t.modules && t.modules.tracks > 0;
      const bL = broken && o.brokenSide >= 0, bR = broken && o.brokenSide <= 0;
      if (bL !== ud.brokenL || bR !== ud.brokenR) { ud.brokenL = bL; ud.brokenR = bR; }
      if (!broken) o.brokenSide = 0;
      const dTread = t.tread - o.lastTread; o.lastTread = t.tread;
      let dRot = t.rot - o.lastRot; o.lastRot = t.rot;
      if (dRot > Math.PI) dRot -= Math.PI * 2; if (dRot < -Math.PI) dRot += Math.PI * 2;
      M.updateTracks(o.root, dTread - dRot * 0.25, dTread + dRot * 0.25);
      const acc = (t.speedNow - o.prevSpeed) / Math.max(dt, 1e-3); o.prevSpeed = t.speedNow;
      o.bob += (Math.max(-1, Math.min(1, -acc * 0.02)) - o.bob) * Math.min(1, dt * 8);
      ud.body.rotation.z = o.bob * 0.06;
      ud.body.position.y = Math.abs(t.speedNow) > 0.1 ? Math.sin(now / 35 + t.id) * 0.004 : 0;
      ud.flag.rotation.y = Math.sin(now / 160 + t.id) * 0.35 + Math.min(1, Math.abs(t.speedNow)) * 0.6;
      ud.ant.visible = !(this.mode === 'chase' && t === focusTank); // it would wave right in front of the lens
      // jammed turret ring: the turret sits crooked and trickles smoke
      const jam = t.modules && t.modules.turret > 0;
      ud.turret.rotation.z += ((jam ? 0.045 : 0) - ud.turret.rotation.z) * Math.min(1, dt * 6);
      if (jam && Math.random() < dt * 4) {
        const [px, py, pz] = this._local(t, vx, vz, ud.spec.turretAt[0], ud.spec.turretAt[1] + 0.02);
        this.fx.smoke.spawn({ x: px, y: py, z: pz, vy: 0.3, size: 0.05, grow: 3, life: 0.9, color: new THREE.Color(0x6a655f), a0: 0.35, drag: 1 });
      }
      o.trackAcc += Math.abs(dTread) + Math.abs(dRot) * 0.25;
      if (o.trackAcc > 0.12) {
        o.trackAcc = 0;
        const s = Math.sin(t.rot), c = Math.cos(t.rot), tz = ud.track.z * sc;
        this.fx.track(vx - s * tz, vz + c * tz, t.rot);
        this.fx.track(vx + s * tz, vz - c * tz, t.rot);
        if (Math.abs(t.speedNow) > 1.2 && Math.random() < 0.5) this.fx.smoke.spawn({ x: vx - c * 0.35, y: 0.05, z: vz - s * 0.35, vy: 0.25, size: 0.1, grow: 3, life: 0.8, color: new THREE.Color(0xc9ad84), a0: 0.25, drag: 2 });
      }
      // damage states: engine smoke under half health, flames while burning
      const hpf = t.hp / (t.maxHp || 1);
      const fogged = seen && this.mode === 'tactical' && focusTank && t.team !== focusTank.team && !seen.has(t.id);
      const showFx = !fogged && !(t.type.invisible && o.vis < 0.3);
      if (showFx && hpf < 0.5) { const [px, py, pz] = this._local(t, vx, vz, ud.spec.deck[0], ud.spec.deck[1]); this.fx.engineSmoke(px, py, pz, dt, Math.min(1, (0.5 - hpf) * 2.2)); }
      if (showFx && t.modules && t.modules.fire > 0) {
        const [px, py, pz] = this._local(t, vx, vz, ud.spec.deck[0] + 0.05, ud.spec.deck[1]);
        this.fx.burn(px, py, pz, dt, 1);
        if (fireK < 2) this.fx.setFireLight(fireK++, px, py, pz, true, this._time);
      }
      // fog of war (tactical) and the ghost's cloak
      if (t.type.invisible || fogged || o.fog) {
        o.fog = fogged || (o.fog && o.vis < 0.98);
        o.reveal = Math.max(0, o.reveal - dt);
        let target = t.type.invisible ? (world.time < 1.8 ? 1 : o.reveal > 0 ? 0.5 : 0.0) : 1;
        if (fogged) target = Math.min(target, o.reveal > 0 ? 0.35 : 0);
        o.vis += (target - o.vis) * Math.min(1, dt * 3);
        for (const m of ud.mats) { m.transparent = true; m.opacity = o.vis; m.depthWrite = o.vis > 0.9; }
        o.shadow.material.opacity = 0.6 * o.vis;
        o.root.visible = o.vis > 0.02;
        const cast = o.vis > 0.5;
        if (cast !== o.shadowCast) { o.shadowCast = cast; o.root.traverse((c) => { if (c.isMesh) { if (c.userData.cast == null) c.userData.cast = c.castShadow; c.castShadow = cast && c.userData.cast; } }); }
      } else o.vis = 1;
    }
    for (let k = fireK; k < 2; k++) this.fx.setFireLight(k, 0, 0, 0, false);
    const sseen = new Set();
    for (const s of world.shells) {
      if (!s.alive) continue;
      sseen.add(s.id);
      let m = this.shellObjs.get(s.id);
      if (!m) {
        m = new THREE.Mesh(s.rocket ? M.rocketGeo() : M.shellGeo(), s.rocket ? M.rocketMat() : M.shellMat());
        m.castShadow = true; m.userData.trail = 0;
        this.scene.add(m); this.shellObjs.set(s.id, m);
      }
      const x = s._rx != null ? s._rx + (s.x - s._rx) * alpha : s.x;
      const z = s._rz != null ? s._rz + (s.z - s._rz) * alpha : s.z;
      const [vx, vz] = toView(x, z);
      m.position.set(vx, 0.4, vz);
      m.rotation.y = -Math.atan2(s.dz, s.dx);
      m.userData.trail += dt;
      const every = s.rocket ? 0.012 : 0.028;
      while (m.userData.trail > every) { m.userData.trail -= every; this.fx.trail(vx - s.dx * 0.1, vz - s.dz * 0.1, s.rocket); }
    }
    for (const [id, m] of this.shellObjs) if (!sseen.has(id)) { this.scene.remove(m); this.shellObjs.delete(id); }
    const mseen = new Set();
    for (const mi of world.mines) {
      if (!mi.alive) continue;
      mseen.add(mi.id);
      let m = this.mineObjs.get(mi.id);
      if (!m) { m = M.buildMine(); this.scene.add(m); this.mineObjs.set(mi.id, m); m.userData.pop = 0; }
      const [vx, vz] = toView(mi.x, mi.z);
      m.userData.pop = Math.min(1, m.userData.pop + dt * 6);
      const pop = m.userData.pop; const sc = pop < 1 ? 1 + Math.sin(pop * Math.PI) * 0.35 : 1;
      m.position.set(vx, 0, vz); m.scale.setScalar(sc);
      const u = mi.t / MINE_FUSE;
      const rate = mi.trigger >= 0 ? 30 : 2 + u * u * 14;
      const on = Math.sin(mi.t * rate * Math.PI) > 0;
      m.userData.lamp.material.emissiveIntensity = mi.armed ? (on ? 7 : 0.2) : 0.5;
    }
    for (const [id, m] of this.mineObjs) if (!mseen.has(id)) { this.scene.remove(m); this.mineObjs.delete(id); }

    this._updateCamera(dt, focusTank, aimYaw ?? (focusTank ? focusTank.aim : 0));
  }

  // A knocked-out tank stays where it died: charred, tracks thrown, turret askew, smouldering.
  _syncWreck(t, o, dt) {
    const ud = o.root.userData;
    if (!ud.wrecked) {
      const [vx, vz] = toView(t.x, t.z);
      o.root.position.set(vx, 0, vz); o.shadow.position.set(vx, 0.003, vz);
      ud.body.rotation.y = -t.rot; ud.turret.rotation.y = -t.aim;
      M.wreckTank(o.root, ((t.id * 0.6180339) % 1));
      for (const m of ud.mats) { m.transparent = m === ud.emblemMat; m.opacity = m === ud.emblemMat ? m.opacity : 1; m.depthWrite = m !== ud.emblemMat; }
      o.root.visible = true; o.shadow.material.opacity = 0.75; o.vis = 1;
      o.root.traverse((c) => { if (c.isMesh && c.userData.cast != null) c.castShadow = c.userData.cast; });
      if (o.wreckT < 0) o.wreckT = 0;
    }
    o.wreckT += dt;
    const [vx, vz] = [o.root.position.x, o.root.position.z];
    // turret blown off by an ammo-rack hit: a short ballistic arc, then it lies on the ground
    if (o.fly) {
      const f = o.fly, tr = ud.turret, s = t.type.scale || 1;
      f.vy -= 13 / s * dt;
      tr.position.x += f.vx * dt; tr.position.y += f.vy * dt; tr.position.z += f.vz * dt;
      tr.rotation.x += f.wx * dt; tr.rotation.z += f.wz * dt;
      if (tr.position.y <= 0.06 && f.vy < 0) {
        tr.position.y = 0.06; f.bounces = (f.bounces || 0) + 1;
        if (f.bounces > 1 || Math.abs(f.vy) < 1.2) { tr.rotation.x = f.restX; tr.rotation.z = f.restZ; o.fly = null; }
        else { f.vy *= -0.3; f.vx *= 0.5; f.vz *= 0.5; }
      }
    }
    const [px, py, pz] = this._local(t, vx, vz, ud.spec.deck[0] + 0.1, ud.spec.deck[1]);
    this.fx.smoulder(px, py, pz, dt, o.wreckT);
    if (o.wreckT < 4) this.fx.burn(px, py, pz, dt, 1 - o.wreckT / 4);
  }

  consume(world) {
    const tankById = (id) => world.tanks.find((t) => t.id === id);
    const shellById = (id) => id == null ? null : world.shells.find((s) => s.id === id);
    const focus = world.tanks.find((t) => t.human);
    const near = (x, z) => focus ? Math.hypot(focus.x - x, focus.z - z) : 10;
    const v3 = new THREE.Vector3();
    for (const e of world.events) {
      const [x, z] = e.x != null ? toView(e.x, e.z) : [0, 0];
      const shakeScale = this.mode === 'chase' ? Math.max(0.25, 1.3 - near(e.x ?? 0, e.z ?? 0) * 0.12) : 1;
      switch (e.type) {
        case 'fire': {
          const t = tankById(e.tank);
          const o = t && this.tankObjs.get(t.id);
          let mx = x, mz = z, my = 0.42;
          if (o) { o.root.updateMatrixWorld(true); o.root.userData.tip.getWorldPosition(v3); mx = v3.x; my = v3.y; mz = v3.z; }
          const big = t ? { light: 0.75, medium: 1, heavy: 1.3, td: 1.4 }[t.type.cls] || 1 : 1;
          this.fx.muzzle(mx, mz, e.angle, e.rocket, my, big);
          if (t && t.type.invisible && o) o.reveal = 0.35;
          this.shake = Math.max(this.shake, t && t.human ? 0.3 + big * 0.08 : 0.08 * shakeScale);
          this.onSound('fire', { rocket: e.rocket, x: e.x, z: e.z, mine: !!(t && t.human), cls: t ? t.type.cls : 'medium' });
          break;
        }
        case 'hit': {
          const t = tankById(e.tank), by = tankById(e.by);
          const info = { x: e.x, z: e.z, tank: e.tank, by: e.by, you: !!(t && t.human), yours: !!(by && by.human), dmg: e.dmg, module: e.module, face: e.face };
          const sc = t ? t.type.scale || 1 : 1;
          const s = shellById(e.shell);
          let dx = s ? s.dx : 0, dz = s ? s.dz : 0;
          if (!s && t) { const l = Math.hypot(e.x - t.x, e.z - t.z) || 1; dx = (e.x - t.x) / l; dz = (e.z - t.z) / l; }
          const y = 0.24 * sc;
          if (e.result === 'ricochet') {
            this.fx.ricochet(x, z, dx, dz, y);
            this.onSound('ricochet', info);
          } else if (e.result === 'nopen') {
            this.fx.clank(x, z, y);
            this.onSound('nopen', info);
          } else {
            const col = t ? (t.colorOverride ?? t.type.color) : 0x888888;
            if (e.mine == null) this.fx.penetrate(x, z, dx, dz, [col, col, t ? t.type.trim : 0x333333, 0x3a3a3c], y + 0.05);
            if (t && e.module === 'tracks') {
              const o = this.tankObjs.get(t.id);
              if (o) {
                // which side got hit (model +z is the tank's left: (-sin rot, cos rot))
                const lz = -(e.x - t.x) * Math.sin(t.rot) + (e.z - t.z) * Math.cos(t.rot);
                o.brokenSide = e.mine != null ? (Math.random() < 0.5 ? 1 : -1) : (lz >= 0 ? 1 : -1);
                this.fx.debrisBurst(x, z, [0x3a3a3c, 0x2a2a2c, 0x55585e], 8, 0.5, { y: 0.1, size: 0.04 });
              }
            }
            if (t && t.human) this.shake = Math.max(this.shake, 0.45);
            this.onSound('pen', info);
          }
          break;
        }
        case 'impact': {
          const s = shellById(e.shell);
          const dx = s ? s.dx : 0, dz = s ? s.dz : 0;
          const surf = this._surfaceAt(e.x + dx * 0.12, e.z + dz * 0.12);
          this.fx.impact(x, z, surf, dx, dz);
          this.onSound('impact', { x: e.x, z: e.z, surface: SURF_NAME[surf] || 'wood' });
          break;
        }
        case 'bounce': this.fx.spark(x, z, 8); this.onSound('ricochet', { x: e.x, z: e.z }); break;
        case 'shellPop': this.fx.puff(x, z, 4); this.fx.spark(x, z, 4, 0xffb070); this.onSound('impact', { x: e.x, z: e.z, surface: 'wood' }); break;
        case 'shellClash': this.fx.spark(x, z, 16, 0xfff0a0); this.fx.puff(x, z, 5); this.onSound('clash', { x: e.x, z: e.z }); break;
        case 'dud': this.fx.puff(x, z, 3); this.onSound('dud', {}); break;
        case 'mine': this.onSound('mine', { x: e.x, z: e.z }); break;
        case 'mineTrip': this.onSound('trip', {}); break;
        case 'fireTick': { const t = tankById(e.tank); this.onSound('burn', { x: e.x, z: e.z, tank: e.tank, you: !!(t && t.human) }); break; }
        case 'explode': {
          this.fx.explosion(x, z, 1.25);
          this.fx.debrisBurst(x, z, [0x2b2b2b, 0xf2c230, 0x1a1a1a], 14, 1.2);
          this.fx.scorch(x, z, Math.random() * 6);
          this.shake = Math.max(this.shake, 0.9 * shakeScale); this.flash = 0.35;
          this.onSound('boom', { big: true, x: e.x, z: e.z });
          break;
        }
        case 'tankDie': {
          const t = tankById(e.tank);
          const ammo = e.cause === 'ammo';
          this.fx.explosion(x, z, ammo ? 1.5 : 1);
          const col = t ? (t.colorOverride ?? t.type.color) : 0x888888;
          let trim = t ? t.type.trim : 0x333333;
          if (new THREE.Color(trim).getHSL({}).l > 0.7) trim = 0x55585e; // no sugar-cube white bits
          this.fx.debrisBurst(x, z, [col, col, 0x3a3a3c, trim, 0x2a2a2c, 0x55585e], ammo ? 36 : 24, ammo ? 1.1 : 0.85, { y: 0.3, size: 0.06 });
          this.fx.scorch(x, z, t ? t.rot : 0);
          const o = t && this.tankObjs.get(t.id);
          if (o) {
            o.wreckT = 0;
            if (ammo) {
              const a = Math.random() * Math.PI * 2, s = t.type.scale || 1;
              o.fly = { vx: Math.cos(a) * 1.2 / s, vy: 5.5 / s, vz: Math.sin(a) * 1.2 / s, wx: (Math.random() - 0.5) * 9, wz: (Math.random() - 0.5) * 9, restX: (Math.random() - 0.5) * 0.5, restZ: (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.4) };
            }
          }
          this.shake = Math.max(this.shake, t && t.human ? 1.2 : 0.7 * shakeScale); this.flash = ammo ? 0.4 : 0.25;
          this.onSound('boom', { big: ammo, ammo, x: e.x, z: e.z, human: !!(t && t.human) });
          break;
        }
        case 'crateBreak': {
          const cell = e.i + e.j * this.cols;
          if (this.props) { breakCrate(this.props.crates, cell); this.props.height[cell] = 0; this.props.surface[cell] = 0; }
          const [cx, cz] = toView(e.i + 0.5, e.j + 0.5);
          this.fx.debrisBurst(cx, cz, [0xc49a64, 0xb38850, 0xd6b478, 0xe0cfa8], 22, 0.8, { y: 0.5, size: 0.12, flat: true });
          this.fx.puff(cx, cz, 10, 0xc9b08a, 0.4);
          this.onSound('crate', { x: e.i + 0.5, z: e.j + 0.5 });
          break;
        }
      }
    }
  }

  // What a shell stopping at sim point (x, z) hit: a SURF code from the props, 0 for the tray.
  _surfaceAt(x, z) {
    const C = this.cols, R = this.rows;
    let best = 0, bd = Infinity;
    for (let j = Math.floor(z - 0.3); j <= Math.floor(z + 0.3); j++) for (let i = Math.floor(x - 0.3); i <= Math.floor(x + 0.3); i++) {
      const d = Math.hypot(Math.max(i, Math.min(x, i + 1)) - x, Math.max(j, Math.min(z, j + 1)) - z);
      if (d >= bd) continue;
      if (i < 0 || j < 0 || i >= C || j >= R) { bd = d; best = SURF.NONE; continue; }
      const c = this.grid[j * C + i];
      if (c === CELL.BLOCK || c === CELL.CRATE) { bd = d; best = (this.props && this.props.surface[j * C + i]) || SURF.WOOD; }
    }
    return best;
  }

  render(dt, time) {
    if (this._envDirty) this._captureEnv();
    this.fx.update(dt, this.solidTop);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    this.post.finalMat.uniforms.flash.value = this.flash * 0.25;
    const info = this.renderer.info;
    info.reset();
    this.post.render(this.scene, this.camera, time);
    this.stats = { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures };
  }
}

// Merge every plain mesh under `group` that shares an equivalent material into one mesh
// (the bedroom's furniture and toys are hundreds of small parts; this makes them ~30).
function mergeStatic(group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map();
  const sig = (m) => [m.type, m.color && m.color.getHex(), m.map && m.map.uuid, m.roughness, m.metalness, m.clearcoat, m.emissive && m.emissive.getHex(), m.emissiveIntensity, m.transparent, m.opacity, m.side, m.roughnessMap && m.roughnessMap.uuid, m.depthWrite].join('|');
  const drop = [];
  group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material)) return;
    const k = sig(o.material);
    const b = buckets.get(k) || { mat: o.material, list: [], cast: false, recv: false, order: o.renderOrder };
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    b.list.push(g); b.cast ||= o.castShadow; b.recv ||= o.receiveShadow;
    buckets.set(k, b); drop.push(o);
  });
  for (const o of drop) { o.parent.remove(o); o.geometry.dispose(); }
  for (const b of buckets.values()) {
    const m = new THREE.Mesh(mergeGeometries(b.list, false), b.mat);
    for (const g of b.list) g.dispose();
    m.castShadow = b.cast; m.receiveShadow = b.recv; m.renderOrder = b.order;
    group.add(m);
  }
}

function mergeSimple(geos) {
  const pos = [], nrm = [], uv = [], idx = [];
  let off = 0;
  for (const g of geos) {
    const gi = g.index ? g.index.array : null;
    pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); uv.push(...g.attributes.uv.array);
    if (gi) for (const i of gi) idx.push(i + off);
    off += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

// A child's crayon drawing of a tank, pinned on the wall.
function drawingTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 384;
  const g = c.getContext('2d');
  g.fillStyle = '#fbf8ef'; g.fillRect(0, 0, 512, 384);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const wob = (pts, col, w) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); pts.forEach(([x, y], k) => { const jx = x + Math.sin(k * 2.1) * 3, jy = y + Math.cos(k * 1.7) * 3; k ? g.lineTo(jx, jy) : g.moveTo(jx, jy); }); g.stroke(); };
  g.fillStyle = 'rgba(80,140,60,0.5)'; g.fillRect(20, 290, 470, 60);
  wob([[110, 270], [400, 270], [430, 230], [80, 230], [110, 270]], '#3a6f2a', 10);
  wob([[160, 230], [170, 180], [300, 180], [320, 230]], '#3a6f2a', 10);
  wob([[300, 200], [460, 170]], '#333', 9);
  for (let k = 0; k < 5; k++) wob([[120 + k * 65, 262], [125 + k * 65, 262]], '#222', 22);
  wob([[60, 70], [100, 70]], '#f2b632', 10); g.fillStyle = '#f2c232'; g.beginPath(); g.arc(80, 70, 28, 0, 7); g.fill();
  g.fillStyle = '#d33'; g.font = 'bold 44px "Comic Sans MS", cursive'; g.fillText('MY TANK', 180, 90);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
