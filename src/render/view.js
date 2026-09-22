// The three.js view of a world. Reads sim state, never changes rules.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { COLS, ROWS, CELL, MINE_FUSE } from '../sim/world.js';
import * as M from './models.js';
import * as TX from './textures.js';
import { FX } from './fx.js';
import { Post } from './post.js';

const OX = COLS / 2, OZ = ROWS / 2;
export const toView = (x, z) => [x - OX, z - OZ];
const FLOOR_Y = -0.36;

export const QUALITY = {
  low:    { name: 'low',    msaa: 0, shadow: 1024, dof: false, bloom: false, motes: false, grass: 0.3, pr: 0.85 },
  medium: { name: 'medium', msaa: 4, shadow: 2048, dof: true,  bloom: true,  motes: true,  grass: 0.7, pr: 1.0 },
  high:   { name: 'high',   msaa: 4, shadow: 4096, dof: true,  bloom: true,  motes: true,  grass: 1.0, pr: 1.5 },
};

export class View {
  constructor(canvas, qualityName = 'high') {
    this.canvas = canvas;
    this.quality = { ...(QUALITY[qualityName] || QUALITY.high) };
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.NoToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a130d);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 260);
    this.post = new Post(r, this.quality);
    this.fx = new FX(this.scene, this.quality);
    this.tankObjs = new Map(); this.shellObjs = new Map(); this.mineObjs = new Map();
    this.boardGroup = null;
    this.shake = 0; this.flash = 0;
    this.mode = 'chase'; // 'chase' | 'tactical'
    this.cam = { introT: 1, blend: 1, pos: new THREE.Vector3(0, 30, 30), look: new THREE.Vector3(), yaw: 0, fitD: 30, lastMode: 'chase' };
    this.onSound = () => {};
    this._buildRoom();
    this._buildAimDots();
    this._envDirty = true;
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
    this._fitTactical();
  }

  // ------------------------------------------------------------ room & lights
  _buildRoom() {
    const s = this.scene;
    const hemi = new THREE.HemisphereLight(0xcfdcff, 0x5a4030, 0.3); s.add(hemi);
    // sunlight through the window on the back wall
    const key = this.key = new THREE.DirectionalLight(0xffe2b8, 2.7);
    key.position.set(-9, 20, -16);
    key.castShadow = true;
    const sc = key.shadow.camera; sc.left = -16; sc.right = 16; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 70;
    key.shadow.bias = -0.0002; key.shadow.normalBias = 0.02;
    s.add(key); s.add(key.target);
    const fill = new THREE.DirectionalLight(0x9fb6ff, 0.5); fill.position.set(14, 10, 18); s.add(fill);
    // warm ceiling lamp far overhead for room fill (no shadow)
    const lamp = new THREE.PointLight(0xffc98a, 160, 80, 1.6); lamp.position.set(8, 24, 10); s.add(lamp);

    // floor (hardwood) + rug under the diorama
    const wf = TX.woodFloor();
    wf.map.repeat.set(7, 7); wf.rough.repeat.set(7, 7);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ map: wf.map, roughnessMap: wf.rough, roughness: 0.5, envMapIntensity: 0.5 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR_Y - 0.02; floor.receiveShadow = true; s.add(floor);
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), new THREE.MeshStandardMaterial({ map: TX.rug(), roughness: 0.95 }));
    rug.rotation.x = -Math.PI / 2; rug.position.y = FLOOR_Y - 0.005; rug.receiveShadow = true; s.add(rug);

    // walls with wallpaper, skirting, window
    const wp = TX.wallpaper();
    const wallMat = new THREE.MeshStandardMaterial({ map: wp, roughness: 0.9 });
    const RW = 34, RD = 28, RH = 30;
    const wall = (w, x, z, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, RH), wallMat); m.position.set(x, FLOOR_Y + RH / 2, z); m.rotation.y = ry; m.receiveShadow = true; s.add(m); };
    wall(RW * 2, 0, -RD, 0); wall(RW * 2, 0, RD, Math.PI); wall(RD * 2, -RW, 0, Math.PI / 2); wall(RD * 2, RW, 0, -Math.PI / 2);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(RW * 2, RD * 2), new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 1 }));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = FLOOR_Y + RH; s.add(ceil);
    const skirt = new THREE.MeshStandardMaterial({ color: 0xf2eee6, roughness: 0.5 });
    for (const [w, x, z, ry] of [[RW * 2, 0, -RD + 0.3, 0], [RW * 2, 0, RD - 0.3, Math.PI], [RD * 2, -RW + 0.3, 0, Math.PI / 2], [RD * 2, RW - 0.3, 0, -Math.PI / 2]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, 1.6, 0.6), skirt); b.position.set(x, FLOOR_Y + 0.8, z); b.rotation.y = ry; s.add(b);
    }
    // window: bright pane (blooms), frame, sill
    const win = new THREE.Group();
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(16, 13), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.0, 2.6) }));
    win.add(pane);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xf6f3ee, roughness: 0.4 });
    for (const [w, h, x, y] of [[17, 0.8, 0, 6.6], [17, 0.8, 0, -6.6], [0.8, 14, -8.2, 0], [0.8, 14, 8.2, 0], [0.5, 13, 0, 0], [16, 0.5, 0, 0]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.6), frameMat); b.position.set(x, y, 0.3); win.add(b);
    }
    const sill = new THREE.Mesh(new THREE.BoxGeometry(18, 0.6, 2), frameMat); sill.position.set(0, -7.1, 1); win.add(sill);
    win.position.set(-8, FLOOR_Y + 16, -RD + 0.05); s.add(win);

    // furniture
    const bed = M.bed(); bed.position.set(-24, FLOOR_Y, 6); s.add(bed);
    const shelf = M.bookshelf(); shelf.position.set(26, FLOOR_Y, -24); s.add(shelf);
    const chest = M.toyChest(); chest.position.set(18, FLOOR_Y, -19); chest.rotation.y = -0.2; s.add(chest);

    // toys scattered on the rug around the diorama (they blur out; they sell the scale)
    const P = [];
    const pen = M.pencil(0xf2c230); pen.position.set(-15.4, FLOOR_Y + 0.42, 3); pen.rotation.y = 1.25; P.push(pen);
    const pen2 = M.pencil(0x2c6fd6); pen2.position.set(15.8, FLOOR_Y + 0.42, -5.5); pen2.rotation.y = -1.9; P.push(pen2);
    [0xd93b30, 0x3aa35b, 0x7c4ec4, 0xf07f2a].forEach((c, k) => { const cr = M.crayon(c); cr.position.set(16 + k * 0.4, FLOOR_Y + 0.5, 4 + k * 1.15); cr.rotation.y = -0.35 + k * 0.12; P.push(cr); });
    const mg = M.mug(); mg.position.set(-18, FLOOR_Y, -7); P.push(mg);
    const b1 = M.brick(0xd93b30, 4, 2); b1.position.set(-15.2, FLOOR_Y, 10); b1.rotation.y = 0.4; P.push(b1);
    const b2 = M.brick(0x2c6fd6, 2, 2); b2.position.set(-14, FLOOR_Y + 0.96, 10.6); b2.rotation.y = 0.9; P.push(b2);
    const b3 = M.brick(0xf0b62a, 3, 2); b3.position.set(15, FLOOR_Y, 10.6); b3.rotation.y = -0.3; P.push(b3);
    for (let k = 0; k < 4; k++) { const so = M.toySoldier(); so.position.set(-16.5 + k * 1.1, FLOOR_Y, -1.6 + (k % 2) * 0.8); so.rotation.y = 0.8 + k * 0.4; so.scale.setScalar(0.62); P.push(so); }
    const b4 = M.brick(0x3aa35b, 2, 4); b4.position.set(8, FLOOR_Y, -12.6); b4.rotation.y = 0.2; P.push(b4);
    const b5 = M.brick(0xe8dcc0, 4, 2); b5.position.set(-7, FLOOR_Y, -12.4); b5.rotation.y = -0.15; P.push(b5);
    for (const p of P) s.add(p);

    // diorama tray (walnut) around the board
    const wal = TX.walnut();
    const frameW = new THREE.MeshPhysicalMaterial({ map: wal, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.25 });
    const T = 0.7, H = 0.95;
    const mk = (w, d, x, z) => { const m = new THREE.Mesh(new RoundedBoxGeometry(w, H, d, 3, 0.08), frameW); m.position.set(x, FLOOR_Y + H / 2, z); m.castShadow = true; m.receiveShadow = true; s.add(m); };
    mk(COLS + T * 2, T, 0, -OZ - T / 2); mk(COLS + T * 2, T, 0, OZ + T / 2);
    mk(T, ROWS, -OX - T / 2, 0); mk(T, ROWS, OX + T / 2, 0);
    const brass = new THREE.MeshStandardMaterial({ color: 0xb8913f, metalness: 1, roughness: 0.45 });
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const c = new THREE.Mesh(new RoundedBoxGeometry(T + 0.06, 0.2, T + 0.06, 2, 0.05), brass);
      c.position.set(x * (OX + T / 2), FLOOR_Y + H + 0.02, z * (OZ + T / 2)); c.castShadow = true; s.add(c);
    }
    // brass maker's plate on the front rail
    const plate = new THREE.Mesh(new RoundedBoxGeometry(3.2, 0.5, 0.05, 2, 0.02), brass);
    plate.position.set(0, FLOOR_Y + 0.5, OZ + T + 0.01); s.add(plate);
  }

  // Reflections come from this actual room, captured once from above the board.
  _captureEnv() {
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cc = new THREE.CubeCamera(0.1, 200, cubeRT);
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
    for (const [, o] of this.tankObjs) this.scene.remove(o.root), this.scene.remove(o.shadow);
    for (const [, o] of this.shellObjs) this.scene.remove(o);
    for (const [, o] of this.mineObjs) this.scene.remove(o);
    this.tankObjs.clear(); this.shellObjs.clear(); this.mineObjs.clear();
    this.fx.clearLevel();

    const g = this.boardGroup = new THREE.Group();
    this.scene.add(g);
    const grid = world.grid;
    this.grid = grid;
    if (!this.terrain) { this.terrain = TX.diorama(COLS, ROWS); this.grain = TX.grainNormal(); }
    const pos = [], uv = [], uv2 = [], nrm = [], idx = [];
    const quad = (x0, z0, x1, z1) => {
      const b = pos.length / 3;
      pos.push(x0 - OX, 0, z0 - OZ, x1 - OX, 0, z0 - OZ, x1 - OX, 0, z1 - OZ, x0 - OX, 0, z1 - OZ);
      uv.push(x0 / COLS, 1 - z0 / ROWS, x1 / COLS, 1 - z0 / ROWS, x1 / COLS, 1 - z1 / ROWS, x0 / COLS, 1 - z1 / ROWS);
      nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    };
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) if (grid[j * COLS + i] !== CELL.PIT) quad(i, j, i + 1, j + 1);
    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    top.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    top.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    top.setIndex(idx);
    const board = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ map: this.terrain.map, roughnessMap: this.terrain.rough, normalMap: this.grain, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 1, envMapIntensity: 0.35 }));
    board.receiveShadow = true; board.userData.own = true;
    g.add(board);
    // board body down to the floor (visible through pits and at the tray)
    const under = new THREE.Mesh(new THREE.BoxGeometry(COLS, 0.34, ROWS), new THREE.MeshStandardMaterial({ color: 0x5a3e24, roughness: 0.9 }));
    under.position.y = -0.18; under.userData.own = true;
    // pits: shell-crater holes with earthy walls
    const pitWall = new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 0.95 });
    const pitFloor = new THREE.MeshStandardMaterial({ color: 0x0b0806, roughness: 1 });
    let anyPit = false;
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      if (grid[j * COLS + i] !== CELL.PIT) continue;
      anyPit = true;
      const cx = i + 0.5 - OX, cz = j + 0.5 - OZ;
      const bot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), pitFloor);
      bot.position.set(cx, -1.2, cz); bot.userData.own = true; g.add(bot);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        const inside = ni >= 0 && nj >= 0 && ni < COLS && nj < ROWS;
        if (inside && grid[nj * COLS + ni] === CELL.PIT) continue;
        const w = new THREE.Mesh(new THREE.PlaneGeometry(1, 1.2), pitWall);
        w.position.set(cx + di * 0.5, -0.6, cz + dj * 0.5);
        w.rotation.y = di ? (di > 0 ? -Math.PI / 2 : Math.PI / 2) : (dj > 0 ? Math.PI : 0);
        w.receiveShadow = true; w.userData.own = true;
        g.add(w);
      }
    }
    if (!anyPit) g.add(under);
    // blocks and crates
    const bmats = M.blockMaterials();
    const aoMat = new THREE.MeshBasicMaterial({ map: TX.squareAO(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    const aoGeo = new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2);
    this.crateMeshes = new Map();
    let h = 7 + (world.levelIndex || 0) * 13;
    const rnd = () => { h = (h * 16807) % 2147483647; return h / 2147483647; };
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const c = grid[j * COLS + i];
      if (c !== CELL.BLOCK && c !== CELL.CRATE) continue;
      const cx = i + 0.5 - OX, cz = j + 0.5 - OZ;
      let m;
      if (c === CELL.BLOCK) {
        m = new THREE.Mesh(M.blockGeo(), bmats[Math.floor(rnd() * bmats.length)]);
        m.position.set(cx + (rnd() - 0.5) * 0.02, 0.47, cz + (rnd() - 0.5) * 0.02);
        m.rotation.y = Math.floor(rnd() * 4) * Math.PI / 2 + (rnd() - 0.5) * 0.05;
      } else {
        m = new THREE.Mesh(M.crateGeo(), M.crateMaterial());
        m.position.set(cx, 0.41, cz);
        m.rotation.y = Math.floor(rnd() * 4) * Math.PI / 2 + (rnd() - 0.5) * 0.08;
        this.crateMeshes.set(i + j * COLS, m);
      }
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
      const ao = new THREE.Mesh(aoGeo, aoMat); ao.position.set(cx, 0.002, cz); g.add(ao);
      if (c === CELL.CRATE) m.userData.ao = ao;
    }
    // 3D grass flock + pebbles on open ground, following the painted grass patches
    const tuftGeo = (() => { const a = new THREE.PlaneGeometry(0.16, 0.1); a.translate(0, 0.05, 0); const b = a.clone().rotateY(Math.PI / 2); const c2 = a.clone().rotateY(Math.PI / 4); const d = a.clone().rotateY(-Math.PI / 4); return this._merge([a, b, c2, d]); })();
    const tuftMat = new THREE.MeshStandardMaterial({ map: this._grassTex || (this._grassTex = TX.grassCard()), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 });
    const MAXT = 2600;
    const grass = new THREE.InstancedMesh(tuftGeo, tuftMat, MAXT);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (let k = 0; k < 9000 && n < MAXT; k++) {
      const x = rnd() * COLS, z = rnd() * ROWS;
      const c = grid[Math.floor(z) * COLS + Math.floor(x)];
      if (c !== CELL.FLOOR) continue;
      const gm = this.terrain.grassAt(x, z);
      if (gm < 0.35 || rnd() > gm) continue;
      const sc = 0.6 + rnd() * 0.8;
      mtx.compose(pv.set(x - OX, 0, z - OZ), q.setFromAxisAngle(up, rnd() * 6.28), sv.set(sc, sc * (0.7 + rnd() * 0.6), sc));
      grass.setMatrixAt(n++, mtx);
    }
    this.grassTotal = n; grass.count = Math.floor(n * this.quality.grass);
    grass.receiveShadow = true;
    g.add(grass); this.grass = grass;
    this.cam.introT = 0;
    this._envDirty = true;
  }

  _merge(geos) {
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

  solidTop = (vx, vz) => {
    const i = Math.floor(vx + OX), j = Math.floor(vz + OZ);
    if (i < 0 || j < 0 || i >= COLS || j >= ROWS) return 0.6;
    const c = this.grid[j * COLS + i];
    return c === CELL.BLOCK ? 0.94 : c === CELL.CRATE ? 0.82 : c === CELL.PIT ? -1.2 : 0;
  };

  // ------------------------------------------------------------ aim line
  _buildAimDots() {
    const g = new THREE.SphereGeometry(0.028, 8, 6);
    this.aimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.0, 1.6), transparent: true, opacity: 0.85, depthWrite: false });
    this.aimDots = new THREE.InstancedMesh(g, this.aimMat, 200);
    this.aimDots.count = 0; this.aimDots.frustumCulled = false; this.aimDots.renderOrder = 20;
    this.scene.add(this.aimDots);
    this.aimRing = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.6, 0.4), transparent: true, depthWrite: false }));
    this.aimRing.visible = false; this.scene.add(this.aimRing);
  }
  // pts: [{x,z}] in sim coords; hit: null | {x,z}
  setAimPath(pts, hit, t) {
    const m = new THREE.Matrix4(), p = new THREE.Vector3();
    const n = Math.min(pts.length, 200);
    const phase = (t * 3) % 1;
    for (let k = 0; k < n; k++) {
      const s = 0.7 - k / n * 0.4;
      m.makeScale(s, s, s).setPosition(p.set(pts[k].x - OX, 0.4, pts[k].z - OZ));
      this.aimDots.setMatrixAt(k, m);
    }
    this.aimDots.count = n; this.aimDots.instanceMatrix.needsUpdate = true;
    this.aimMat.color.setRGB(hit ? 3 : 2.2, hit ? 0.7 : 2.0, hit ? 0.5 : 1.6);
    this.aimRing.visible = !!hit;
    if (hit) { this.aimRing.position.set(hit.x - OX, 0.03, hit.z - OZ); this.aimRing.scale.setScalar(1 + Math.sin(t * 10) * 0.08); }
    void phase;
  }
  hideAim() { this.aimDots.count = 0; this.aimRing.visible = false; }

  // ------------------------------------------------------------ cameras
  _fitTactical() {
    const cam = this.camera;
    const elev = THREE.MathUtils.degToRad(57);
    const dir = new THREE.Vector3(0, Math.sin(elev), Math.cos(elev));
    const target = new THREE.Vector3(0, 0, 0.5);
    const hx = OX + 0.75, hz = OZ + 0.75;
    const pts = [[-hx, 0.6, -hz], [hx, 0.6, -hz], [-hx, 0.6, hz], [hx, 0.6, hz], [-hx, FLOOR_Y, hz], [hx, FLOOR_Y, hz]].map((p) => new THREE.Vector3(...p));
    const v = new THREE.Vector3();
    const savePos = cam.position.clone(), saveQ = cam.quaternion.clone(), saveFov = cam.fov;
    cam.fov = 32;
    let lo = 5, hi = 140;
    for (let it = 0; it < 30; it++) {
      const d = (lo + hi) / 2;
      cam.position.copy(target).addScaledVector(dir, d);
      cam.up.set(0, 1, 0); cam.lookAt(target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      let ok = true;
      for (const p of pts) { v.copy(p).project(cam); if (Math.abs(v.x) > 0.965 || Math.abs(v.y) > 0.9) { ok = false; break; } }
      if (ok) hi = d; else lo = d;
    }
    this.tac = { pos: target.clone().addScaledVector(dir, hi), look: target };
    cam.position.copy(savePos); cam.quaternion.copy(saveQ); cam.fov = saveFov; cam.updateProjectionMatrix();
  }

  // The chase rig: behind the turret, low, looking a few cells ahead.
  _chasePose(tank, aimYaw) {
    const [vx, vz] = toView(tank.x, tank.z);
    const fx = Math.cos(aimYaw), fz = Math.sin(aimYaw);
    // Low rig: the lens sits just over the turret, below the tops of the toy blocks, so
    // walls genuinely hide what's behind them. Backed against a wall, it slides in.
    let back = 1.55;
    const height = 0.74;
    for (let k = 0; k < 8; k++) {
      let blocked = false;
      for (let s = 0.3; s <= 1.001; s += 0.1) {
        const px = tank.x - fx * back * s, pz = tank.z - fz * back * s;
        const i = Math.floor(px), j = Math.floor(pz);
        const c = this.grid ? (i < 0 || j < 0 || i >= COLS || j >= ROWS ? CELL.BLOCK : this.grid[j * COLS + i]) : 0;
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
    c.introT = Math.min(1, c.introT + dt / 2.2);
    if (c.lastMode !== this.mode) { c.blend = 0; c.lastMode = this.mode; }
    c.blend = Math.min(1, c.blend + dt / 0.7);
    let want;
    if (this.mode === 'orbit') {
      const a = performance.now() / 1000 * 0.05;
      want = { pos: this.tac.pos.clone().multiplyScalar(0.92).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(a) * 0.5), look: new THREE.Vector3(0, 0, 0.6) };
      cam.fov += (32 - cam.fov) * Math.min(1, dt * 4);
    } else if (this.mode === 'chase' && focus && focus.alive) {
      want = this._chasePose(focus, aimYaw);
      cam.fov += (62 - cam.fov) * Math.min(1, dt * 4);
    } else {
      const lean = focus && focus.alive ? new THREE.Vector3(focus.x - OX, 0, focus.z - OZ).multiplyScalar(0.035) : new THREE.Vector3();
      want = { pos: this.tac.pos.clone().add(lean), look: this.tac.look.clone().add(lean) };
      cam.fov += (32 - cam.fov) * Math.min(1, dt * 4);
    }
    // mission intro: start high over the whole diorama and swoop down into the pose
    const e = 1 - Math.pow(1 - c.introT, 3);
    if (e < 1) {
      const hi = this.tac.pos.clone().multiplyScalar(1.25).applyAxisAngle(new THREE.Vector3(0, 1, 0), (1 - e) * 0.9);
      want.pos = hi.lerp(want.pos, e);
      want.look = this.tac.look.clone().lerp(want.look, e);
    }
    const k = c.blend < 1 ? Math.min(1, dt * 6) : this.mode === 'chase' ? Math.min(1, dt * 10) : Math.min(1, dt * 5);
    const kk = c.snap ? 1 : k;
    c.pos.lerp(want.pos, e < 1 ? 1 : kk);
    c.look.lerp(want.look, e < 1 ? 1 : kk);
    if (c.snap) { cam.fov = this.mode === 'chase' && focus && focus.alive ? 62 : 32; c.blend = 1; c.snap = false; }
    cam.position.copy(c.pos);
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const s = this.shake * this.shake * (this.mode === 'chase' ? 0.12 : 0.35), t = performance.now() / 1000;
    cam.position.x += Math.sin(t * 43.1) * s; cam.position.y += Math.sin(t * 37.7 + 1) * s * 0.6; cam.position.z += Math.sin(t * 51.3 + 2) * s;
    cam.up.set(0, 1, 0);
    cam.lookAt(c.look);
    cam.updateProjectionMatrix();
    const cu = this.post.cocMat.uniforms;
    cu.mode.value = this.mode === 'chase' && focus && focus.alive ? 1 : 0;
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

  // ------------------------------------------------------------ sync
  _tankObj(t) {
    let o = this.tankObjs.get(t.id);
    if (o) return o;
    const emblem = t.human ? 'star' : t.typeKey === 'boss' ? 'skull' : 'ring';
    const root = M.buildTank(t.type, { emblem, colorOverride: t.colorOverride });
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.85).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this._blob || (this._blob = TX.blobShadow()), transparent: true, depthWrite: false, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -1 }));
    this.scene.add(root); this.scene.add(shadow);
    o = { root, shadow, lastTread: t.tread, lastRot: t.rot, trackAcc: 0, vis: 1, reveal: 0, bob: 0, prevSpeed: 0 };
    this.tankObjs.set(t.id, o);
    return o;
  }

  sync(world, alpha, dt, focusTank, aimYaw, seen = null) {
    const now = performance.now();
    for (const t of world.tanks) {
      const o = this._tankObj(t);
      if (!t.alive) { o.root.visible = false; o.shadow.visible = false; continue; }
      const x = t._rx != null ? t._rx + (t.x - t._rx) * alpha : t.x;
      const z = t._rz != null ? t._rz + (t.z - t._rz) * alpha : t.z;
      const [vx, vz] = toView(x, z);
      o.root.position.set(vx, 0, vz);
      o.shadow.position.set(vx, 0.003, vz); o.shadow.rotation.y = -t.rot;
      const ud = o.root.userData;
      ud.body.rotation.y = -t.rot;
      ud.turret.rotation.y = -t.aim;
      ud.barrel.position.x = 0.22 - t.recoil * t.recoil * 0.09;
      // tracks: straight travel moves both sides; turning in place counter-rotates them
      const dTread = t.tread - o.lastTread; o.lastTread = t.tread;
      let dRot = t.rot - o.lastRot; o.lastRot = t.rot;
      if (dRot > Math.PI) dRot -= Math.PI * 2; if (dRot < -Math.PI) dRot += Math.PI * 2;
      M.updateTracks(o.root, dTread - dRot * 0.25, dTread + dRot * 0.25);
      const acc = (t.speedNow - o.prevSpeed) / Math.max(dt, 1e-3); o.prevSpeed = t.speedNow;
      o.bob += (Math.max(-1, Math.min(1, -acc * 0.02)) - o.bob) * Math.min(1, dt * 8);
      ud.body.rotation.z = o.bob * 0.06;
      ud.body.position.y = Math.abs(t.speedNow) > 0.1 ? Math.sin(now / 35 + t.id) * 0.004 : 0;
      ud.flag.rotation.y = Math.sin(now / 160 + t.id) * 0.35 + Math.min(1, Math.abs(t.speedNow)) * 0.6;
      o.trackAcc += Math.abs(dTread) + Math.abs(dRot) * 0.25;
      if (o.trackAcc > 0.12) {
        o.trackAcc = 0;
        const s = Math.sin(t.rot), c = Math.cos(t.rot);
        this.fx.track(vx - s * 0.25, vz + c * 0.25, t.rot);
        this.fx.track(vx + s * 0.25, vz - c * 0.25, t.rot);
        if (Math.abs(t.speedNow) > 1.2 && Math.random() < 0.5) this.fx.smoke.spawn({ x: vx - c * 0.35, y: 0.05, z: vz - s * 0.35, vy: 0.25, size: 0.1, grow: 3, life: 0.8, color: new THREE.Color(0xc9ad84), a0: 0.25, drag: 2 });
      }
      const fogged = seen && this.mode === 'tactical' && focusTank && t.team !== focusTank.team && !seen.has(t.id);
      if (t.type.invisible || fogged || o.fog) {
        o.fog = fogged || (o.fog && o.vis < 0.98);
        o.reveal = Math.max(0, o.reveal - dt);
        let target = t.type.invisible ? (world.time < 1.8 ? 1 : o.reveal > 0 ? 0.5 : 0.0) : 1;
        if (fogged) target = Math.min(target, o.reveal > 0 ? 0.35 : 0);
        o.vis += (target - o.vis) * Math.min(1, dt * 3);
        for (const m of ud.mats) { m.transparent = true; m.opacity = o.vis; m.depthWrite = o.vis > 0.9; }
        ud.links.material.transparent = true;
        o.shadow.material.opacity = 0.6 * o.vis;
        o.root.visible = o.vis > 0.02;
        o.root.traverse((c) => { if (c.isMesh) c.castShadow = o.vis > 0.5; });
      }
    }
    const seen = new Set();
    for (const s of world.shells) {
      if (!s.alive) continue;
      seen.add(s.id);
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
    for (const [id, m] of this.shellObjs) if (!seen.has(id)) { this.scene.remove(m); this.shellObjs.delete(id); }
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

  consume(world) {
    const tankById = (id) => world.tanks.find((t) => t.id === id);
    const focus = world.tanks.find((t) => t.human);
    const near = (x, z) => focus ? Math.hypot(focus.x - x, focus.z - z) : 10;
    for (const e of world.events) {
      const [x, z] = e.x != null ? toView(e.x, e.z) : [0, 0];
      const shakeScale = this.mode === 'chase' ? Math.max(0.25, 1.3 - near(e.x ?? 0, e.z ?? 0) * 0.12) : 1;
      switch (e.type) {
        case 'fire': {
          this.fx.muzzle(x, z, e.angle, e.rocket);
          const t = tankById(e.tank);
          if (t && t.type.invisible) { const o = this.tankObjs.get(t.id); if (o) o.reveal = 0.35; }
          this.shake = Math.max(this.shake, t && t.human ? 0.35 : 0.08 * shakeScale);
          this.onSound('fire', { rocket: e.rocket, x: e.x, z: e.z, mine: t && t.human });
          break;
        }
        case 'bounce': this.fx.spark(x, z, 8); this.onSound('bounce', { x: e.x, z: e.z }); break;
        case 'shellPop': this.fx.puff(x, z, 4); this.fx.spark(x, z, 4, 0xffb070); this.onSound('pop', { x: e.x, z: e.z }); break;
        case 'shellClash': this.fx.spark(x, z, 16, 0xfff0a0); this.fx.puff(x, z, 5); this.onSound('clash', { x: e.x, z: e.z }); break;
        case 'dud': this.fx.puff(x, z, 3); this.onSound('dud', {}); break;
        case 'mine': this.onSound('mine', { x: e.x, z: e.z }); break;
        case 'mineTrip': this.onSound('trip', {}); break;
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
          this.fx.explosion(x, z, 1);
          const col = t ? (t.colorOverride ?? t.type.color) : 0x888888;
          const trim = t ? t.type.trim : 0x333333;
          this.fx.debrisBurst(x, z, [col, col, col, trim, 0x3a3a3c, 0x55585e], 34, 1);
          this.fx.scorch(x, z, t ? t.rot : 0);
          this.shake = Math.max(this.shake, t && t.human ? 1.2 : 0.7 * shakeScale); this.flash = 0.25;
          this.onSound('boom', { big: false, x: e.x, z: e.z, human: t && t.human });
          break;
        }
        case 'crateBreak': {
          const m = this.crateMeshes.get(e.i + e.j * COLS);
          if (m) { this.boardGroup.remove(m); if (m.userData.ao) this.boardGroup.remove(m.userData.ao); }
          const [cx, cz] = toView(e.i + 0.5, e.j + 0.5);
          this.fx.debrisBurst(cx, cz, [0xc49a64, 0xb38850, 0xd6b478], 18, 0.8);
          this.fx.puff(cx, cz, 8, 0xc9b08a);
          break;
        }
      }
    }
  }

  render(dt, time) {
    if (this._envDirty) this._captureEnv();
    this.fx.update(dt, this.solidTop);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    this.post.finalMat.uniforms.flash.value = this.flash * 0.25;
    this.post.render(this.scene, this.camera, time);
  }
}
