// Small seeded PRNG (mulberry32) for deterministic matchmaking and tests.
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (n) => Math.floor(r() * n);
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.range = (a0, a1) => a0 + r() * (a1 - a0);
  r.shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  return r;
}
