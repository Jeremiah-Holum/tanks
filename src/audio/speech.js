// Crew voice via speechSynthesis: priority-ordered, rate-limited, toggleable. Lines raised in
// the same sim step are collected for a moment so the most important one wins ("Target
// destroyed!" beats "Penetration!").

// key: [text, priority 1..10, per-line cooldown s]
export const LINES = {
  pen: ['Penetration!', 5, 1.5], nopen: ["Didn't penetrate!", 5, 1.5], ricochet: ['Ricochet!', 5, 1.5],
  crit: ['Critical hit!', 6, 1.5], track: ['Hit their track!', 4, 3], hit: ['Hit!', 3, 3],
  kill: ['Target destroyed!', 8, 1], spotted: ["We've been spotted!", 9, 6], enemySpotted: ['Enemy spotted!', 2, 12],
  fire: ["We're on fire!", 9, 4], fireOut: ['Fire extinguished.', 4, 4],
  engineDmg: ['Engine damaged!', 7, 5], engineDead: ['Engine destroyed!', 8, 5], trackDead: ['Track destroyed!', 7, 3],
  gunDmg: ['Gun damaged!', 6, 5], gunDead: ['Gun destroyed!', 7, 5], ammoDmg: ['Ammo rack damaged!', 8, 5],
  fuelDmg: ['Fuel tank hit!', 6, 5], ringDmg: ['Turret ring damaged!', 6, 5], repaired: ['Repairs complete.', 3, 5],
  commander: ['Commander is wounded!', 7, 3], gunner: ['Gunner is wounded!', 7, 3], driver: ['Driver is wounded!', 7, 3],
  radioman: ['Radio operator is wounded!', 6, 3], loader: ['Loader is wounded!', 7, 3], healed: ['Crew treated.', 3, 5],
  hitUs: ["We're hit!", 3, 3], bounceUs: ['That one bounced!', 4, 3], heldUs: ['Armour held!', 4, 3],
  killed: ["We're knocked out!", 9, 5],
  reloaded: ['Reloaded', 1, 6], baseLost: ['Our base is being captured!', 8, 20], baseWin: ['Enemy base capture in progress', 5, 20],
  victory: ['Victory!', 10, 5], defeat: ['Defeat.', 10, 5], draw: ['Draw.', 10, 5],
};
const BY_TEXT = new Map(Object.entries(LINES).map(([k, v]) => [v[0].toLowerCase(), k]));

export class Crew {
  constructor(A) { this.A = A; this.on = true; this.q = []; this.cool = new Map(); this.speaking = null; this.voice = null; this.rate = 1.08; this.pitch = 0.82; }
  get synth() { return typeof speechSynthesis !== 'undefined' ? speechSynthesis : null; }
  init() {
    const s = this.synth; if (!s || this._init) return; this._init = true;
    const pick = () => { this.voice = pickVoice(s.getVoices() || []); };
    pick(); try { s.addEventListener ? s.addEventListener('voiceschanged', pick) : (s.onvoiceschanged = pick); } catch (e) {}
  }
  // line: a LINES key or free text. Returns true if queued.
  say(line, prio) {
    if (!this.on || !line) return false;
    const key = LINES[line] ? line : BY_TEXT.get(String(line).toLowerCase()) || null;
    const [text, p, cd] = key ? LINES[key] : [String(line), 3, 2];
    const pr = prio ?? p, now = nowS(), id = key || text;
    if ((this.cool.get(id) || 0) > now) return false;
    this.cool.set(id, now + cd);
    this.last = text; this.log && this.log.push(text);
    if (!this.synth) return false;
    this.init();
    this.q.push({ text, pr, at: now });
    if (!this._flush && typeof setTimeout !== 'undefined') this._flush = setTimeout(() => { this._flush = null; this.pump(); }, 70);
    return true;
  }
  pump() {
    const s = this.synth; if (!s) return;
    const now = nowS();
    this.q = this.q.filter((x) => now - x.at < 3).sort((a, b) => b.pr - a.pr).slice(0, 3);
    if (this.speaking && now - this.speaking.start > 4.5) this.speaking = null; // onend never came
    const top = this.q[0]; if (!top) return;
    if (this.speaking) {
      if (top.pr < this.speaking.pr + 3) return;             // wait for the current line
      try { s.cancel(); } catch (e) {}
    }
    if (now - (this.lastStart || 0) < 0.5 && !this.speaking) { setTimeout(() => this.pump(), 500); return; }
    this.q.shift();
    // drop anything much less important that was raised alongside it
    this.q = this.q.filter((x) => x.pr >= top.pr - 2);
    const u = new SpeechSynthesisUtterance(top.text);
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = 'en-GB';
    u.rate = this.rate; u.pitch = this.pitch; u.volume = clamp01(this.A.vol.voice * this.A.vol.master * 1.25);
    const cur = this.speaking = { pr: top.pr, start: now };
    const done = () => { if (this.speaking === cur) this.speaking = null; setTimeout(() => this.pump(), 150); };
    u.onend = done; u.onerror = done;
    this.lastStart = now;
    this.A._squelch();
    try { s.speak(u); } catch (e) { this.speaking = null; }
  }
  cancel() { this.q = []; this.speaking = null; try { this.synth && this.synth.cancel(); } catch (e) {} }
}

const nowS = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Prefer an English male voice; British/American first; local voices over network ones.
export function pickVoice(vs) {
  const en = vs.filter((v) => /^en[-_]/i.test(v.lang) || /english/i.test(v.name));
  if (!en.length) return vs[0] || null;
  const score = (v) => (/male|daniel|david|george|alex|fred|guy|mark|james|ryan|thomas|oliver|arthur|aaron|rishi|gordon|lee/i.test(v.name) && !/female/i.test(v.name) ? 10 : 0)
    - (/female|zira|samantha|victoria|karen|susan|hazel|serena|moira|tessa|fiona|kate|libby|sonia|jenny|aria|emma/i.test(v.name) ? 10 : 0)
    + (/en[-_]gb/i.test(v.lang) ? 3 : /en[-_]us/i.test(v.lang) ? 2 : 0) + (v.localService ? 1 : 0);
  return en.slice().sort((a, b) => score(b) - score(a))[0];
}
