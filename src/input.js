// Keyboard, mouse (with pointer lock for the chase cam) and gamepad.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();      // keys pressed since last poll
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2, dx: 0, dy: 0, left: false, right: false, leftHit: false, rightHit: false };
    this.locked = false;
    this.lastDevice = 'kbm';
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code); this.pressed.add(e.code); this.lastDevice = 'kbm';
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      if (this.locked) { this.mouse.dx += e.movementX || 0; this.mouse.dy += e.movementY || 0; }
      this.lastDevice = 'kbm';
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftHit = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightHit = true; }
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.left = false; if (e.button === 2) this.mouse.right = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    this.pad = { lx: 0, ly: 0, rx: 0, ry: 0, fire: false, mine: false, fireHit: false, mineHit: false, startHit: false, viewHit: false, connected: false };
    this._padPrev = {};
  }

  requestLock() { if (!this.locked && this.canvas.requestPointerLock) { try { const p = this.canvas.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => { try { this.canvas.requestPointerLock(); } catch {} }); } catch { try { this.canvas.requestPointerLock(); } catch {} } } }
  releaseLock() { if (this.locked) document.exitPointerLock(); }

  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected);
    const P = this.pad;
    P.connected = !!gp;
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      P.lx = dz(gp.axes[0] || 0); P.ly = dz(gp.axes[1] || 0); P.rx = dz(gp.axes[2] || 0); P.ry = dz(gp.axes[3] || 0);
      const b = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.4));
      const fire = b(7) || b(0), mine = b(6) || b(1), start = b(9), view = b(3);
      P.fireHit = fire && !this._padPrev.fire; P.mineHit = mine && !this._padPrev.mine;
      P.startHit = start && !this._padPrev.start; P.viewHit = view && !this._padPrev.view;
      P.fire = fire; P.mine = mine;
      this._padPrev = { fire, mine, start, view };
      if (Math.abs(P.lx) + Math.abs(P.ly) + Math.abs(P.rx) + Math.abs(P.ry) > 0.2 || fire || mine) this.lastDevice = 'pad';
    } else { P.lx = P.ly = P.rx = P.ry = 0; P.fireHit = P.mineHit = P.startHit = P.viewHit = false; }
  }

  // Call once per frame after reading.
  endFrame() {
    this.pressed.clear();
    this.mouse.dx = this.mouse.dy = 0;
    this.mouse.leftHit = this.mouse.rightHit = false;
  }

  hit(...codes) { return codes.some((c) => this.pressed.has(c)); }
  down(...codes) { return codes.some((c) => this.keys.has(c)); }
}
