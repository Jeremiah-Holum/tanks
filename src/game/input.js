// Battle input: keyboard state, mouse deltas (pointer lock when available), wheel steps and
// button edges. The battle controller reads it once per rendered frame:
//   input.down('KeyW') · input.take('KeyR') (pressed since last take) · input.mouse() → {dx, dy}
//   input.wheel() → steps (+ = zoom in) · input.btn(0|2) held · input.takeBtn(0|2) pressed edge
// Keys are KeyboardEvent.code. Nothing here knows about tanks.
export class Input {
  constructor(el) {
    this.el = el;
    this.keys = new Set(); this.pressed = new Set();
    this.buttons = [false, false, false]; this.clicks = [0, 0, 0]; this.releases = [0, 0, 0];
    this.dx = 0; this.dy = 0; this.wheelSteps = 0; this._wheelAcc = 0;
    this.enabled = false; this.locked = false;
    const on = (t, k, f, o) => { t.addEventListener(k, f, o); this._off.push(() => t.removeEventListener(k, f, o)); };
    this._off = [];
    on(window, 'keydown', (e) => {
      if (!this.enabled) return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.code === 'Tab' || e.code === 'Space' || (e.code.startsWith('Digit'))) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    on(window, 'keyup', (e) => { this.keys.delete(e.code); });
    on(window, 'blur', () => { this.keys.clear(); this.buttons = [false, false, false]; });
    on(window, 'mousemove', (e) => {
      if (!this.enabled) return;
      this.dx += e.movementX || 0; this.dy += e.movementY || 0;
    });
    on(el, 'mousedown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.buttons[e.button] = true; this.clicks[e.button]++;
      if (!this.locked) this.lock();
    });
    on(window, 'mouseup', (e) => { if (this.buttons[e.button]) this.releases[e.button]++; this.buttons[e.button] = false; });
    on(el, 'contextmenu', (e) => e.preventDefault());
    on(el, 'wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      // one step per notch (100 px) on mice, accumulate small trackpad deltas
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this._wheelAcc += d;
      while (this._wheelAcc >= 60) { this.wheelSteps--; this._wheelAcc -= 100; }
      while (this._wheelAcc <= -60) { this.wheelSteps++; this._wheelAcc += 100; }
      if (Math.abs(this._wheelAcc) < 60) this._wheelAcc *= 0.5;
    }, { passive: false });
    on(document, 'pointerlockchange', () => { this.locked = document.pointerLockElement === el; });
  }

  lock() {
    try {
      const r = this.el.requestPointerLock && this.el.requestPointerLock();
      if (r && r.catch) r.catch(() => {}); // headless or not allowed: plain mouse deltas still work
    } catch { /* not available */ }
  }
  unlock() { try { if (document.pointerLockElement) document.exitPointerLock(); } catch { /* ignore */ } }
  enable(on) { this.enabled = on; if (!on) { this.keys.clear(); this.pressed.clear(); this.buttons = [false, false, false]; this.unlock(); } this.flush(); }
  flush() { this.dx = this.dy = 0; this.wheelSteps = 0; this.pressed.clear(); this.clicks = [0, 0, 0]; this.releases = [0, 0, 0]; }

  down(code) { return this.keys.has(code); }
  take(code) { const p = this.pressed.has(code); this.pressed.delete(code); return p; }
  btn(b) { return this.buttons[b]; }
  takeBtn(b) { const n = this.clicks[b]; this.clicks[b] = 0; return n > 0; }
  takeRelease(b) { const n = this.releases[b]; this.releases[b] = 0; return n > 0; }
  mouse() { const r = { dx: this.dx, dy: this.dy }; this.dx = this.dy = 0; return r; }
  wheel() { const w = this.wheelSteps; this.wheelSteps = 0; return w; }
  dispose() { this.unlock(); for (const f of this._off) f(); this._off = []; }
}
