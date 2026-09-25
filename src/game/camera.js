// WoT-style camera: arcade (third person orbiting a pivot above the tank, collision-aware) and
// sniper (at the gun, ×2/×4/×8). The mouse turns the look direction (yaw, pitch); the aim ray is
// the screen centre, which in arcade passes through the pivot.
//   cam.turn(dx, dy, sens) · cam.zoomStep(+1|-1) · cam.toggleSniper() · cam.update(focus, dt)
//   cam.pos / cam.dir / cam.fov / cam.sniper / cam.zoom
import { raycastTerrain, raycastObjects } from '../sim/map/query.js';

const DEG = Math.PI / 180;
export const ARCADE_MIN = 6, ARCADE_MAX = 30, ZOOMS = [2, 4, 8];
const PITCH_ARCADE = [-62 * DEG, 28 * DEG], PITCH_SNIPER = [-35 * DEG, 30 * DEG];

export class GameCamera {
  constructor({ fov = 70, heightAt = null } = {}) {
    this.baseFov = fov;
    this.heightAt = heightAt;         // rendered ground height (x, z) → y
    this.yaw = 0; this.pitch = -8 * DEG;
    this.dist = 13; this.distWant = 13; this.distCol = 13;
    this.sniper = false; this.zoomIdx = 0;
    this.pos = { x: 0, y: 0, z: 0 }; this.dir = { x: 0, y: 0, z: 1 }; this.look = { x: 0, y: 0, z: 1 };
    this.pivot = { x: 0, y: 0, z: 0 };
    this.fov = fov; this.fovNow = fov;
    this.shake = 0;
  }
  get zoom() { return this.sniper ? ZOOMS[this.zoomIdx] : 1; }

  setYawPitch(yaw, pitch) { this.yaw = yaw; this.pitch = pitch; this._clampPitch(); }
  _clampPitch() { const [a, b] = this.sniper ? PITCH_SNIPER : PITCH_ARCADE; this.pitch = Math.max(a, Math.min(b, this.pitch)); }

  // Mouse: radians per pixel scaled by sensitivity; in sniper by the zoom's fov too.
  turn(dx, dy, sens = 1, invertY = false) {
    const k = 0.0022 * sens * (this.sniper ? Math.tan(this.fov * DEG / 2) / Math.tan(this.baseFov * DEG / 2) : 1);
    this.yaw -= dx * k;
    this.pitch += (invertY ? dy : -dy) * k;
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI; else if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
    this._clampPitch();
  }

  // Wheel: + = in. Past the closest arcade distance → sniper ×2, then ×4, ×8; out reverses.
  // Returns 'sniper-in' | 'sniper-out' | null when the mode changed.
  zoomStep(n) {
    if (n > 0) {
      if (!this.sniper) {
        if (this.distWant > ARCADE_MIN + 0.01) { this.distWant = Math.max(ARCADE_MIN, this.distWant / 1.25); return null; }
        this.sniper = true; this.zoomIdx = 0; return 'sniper-in';
      }
      this.zoomIdx = Math.min(ZOOMS.length - 1, this.zoomIdx + 1); return null;
    }
    if (this.sniper) {
      if (this.zoomIdx > 0) { this.zoomIdx--; return null; }
      this.sniper = false; this.distWant = ARCADE_MIN; return 'sniper-out';
    }
    this.distWant = Math.min(ARCADE_MAX, this.distWant * 1.25); return null;
  }
  toggleSniper() { this.sniper = !this.sniper; if (this.sniper) this.zoomIdx = Math.max(0, this.zoomIdx); this._clampPitch(); return this.sniper ? 'sniper-in' : 'sniper-out'; }

  // Point the look direction from `from` at a world point (keeps the aim point across mode switches).
  lookAt(from, p) {
    const dx = p.x - from.x, dy = p.y - from.y, dz = p.z - from.z, r = Math.hypot(dx, dz);
    if (r < 0.5) return;
    this.yaw = Math.atan2(dx, dz); this.pitch = Math.atan2(dy, r); this._clampPitch();
  }

  // focus: { pivot: {x,y,z} (arcade orbit centre), eye: {x,y,z} (sniper, at the gun) }, map
  update(focus, map, dt) {
    const cp = Math.cos(this.pitch), d = this.dir;
    d.x = Math.sin(this.yaw) * cp; d.y = Math.sin(this.pitch); d.z = Math.cos(this.yaw) * cp;
    const targetFov = this.sniper ? 2 * Math.atan(Math.tan(this.baseFov * DEG / 2) / ZOOMS[this.zoomIdx]) / DEG : this.baseFov;
    this.fovNow += (targetFov - this.fovNow) * Math.min(1, dt * 14);
    if (Math.abs(targetFov - this.fovNow) < 0.05) this.fovNow = targetFov;
    this.fov = this.fovNow;
    if (this.sniper) {
      const e = focus.eye;
      this.pos.x = e.x; this.pos.y = e.y; this.pos.z = e.z;
    } else {
      const p = focus.pivot; this.pivot.x = p.x; this.pivot.y = p.y; this.pivot.z = p.z;
      this.dist += (this.distWant - this.dist) * Math.min(1, dt * 10);
      // collision: pull the camera in front of terrain and solid props between it and the pivot
      const back = { x: -d.x, y: -d.y, z: -d.z };
      let lim = this.dist;
      if (map) {
        const tt = raycastTerrain(map, p, back, lim + 0.8);
        if (tt >= 0) lim = Math.min(lim, tt - 0.8);
        const ob = raycastObjects(map, p, back, lim + 0.6, 'sight');
        if (ob) lim = Math.min(lim, ob.t - 0.6);
      }
      lim = Math.max(1.2, lim);
      // snap in at once, ease back out
      this.distCol = lim < this.distCol ? lim : this.distCol + (lim - this.distCol) * Math.min(1, dt * 3);
      const r = Math.min(this.dist, this.distCol);
      this.pos.x = p.x + back.x * r; this.pos.y = p.y + back.y * r; this.pos.z = p.z + back.z * r;
      if (this.heightAt) { const g = this.heightAt(this.pos.x, this.pos.z) + 0.7; if (this.pos.y < g) this.pos.y = g; }
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.5);
    this.look.x = this.pos.x + d.x * 100; this.look.y = this.pos.y + d.y * 100; this.look.z = this.pos.z + d.z * 100;
    if (this.shake > 0) { const s = this.shake * this.shake * 0.9; this.look.x += (Math.random() - 0.5) * s; this.look.y += (Math.random() - 0.5) * s; }
  }
}
