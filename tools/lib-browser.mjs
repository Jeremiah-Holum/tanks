// Shared helpers for the headless-browser tools (verify, shot-game): dev server on 8477 (started
// and stopped here when nothing is listening), Chromium with SwiftShader, Google Fonts served
// through curl (headless Chrome can't use the sandbox proxy), console/page error collection.
// Always run the tools through tools/capped.sh (one browser on the machine at a time).
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

export const PORT = +(process.env.SF_PORT || 8477);
const external = (u) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:');
const fonts = (u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u);

async function listening() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`); return r.ok; } catch { return false; }
}
export async function startServer() {
  if (await listening()) return null;
  const p = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 100));
  return p;
}

export async function openBrowser({ w = 1280, h = 720 } = {}) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    if (url && external(url)) return;
    errors.push('console: ' + m.text() + (url ? ` (${url.replace(/^.*\/\/[^/]+/, '')})` : ''));
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' ')));
  page.on('requestfailed', (r) => { if (!external(r.url())) errors.push('requestfailed: ' + r.url()); });
  page.on('response', (r) => { if (r.status() >= 400 && !external(r.url())) errors.push(r.status() + ' ' + r.url()); });
  await page.route((u) => external(u.toString()) && !fonts(u.toString()), (r) => r.abort());
  const cache = tmpdir() + '/sf-font-cache'; mkdirSync(cache, { recursive: true });
  await page.route((u) => fonts(u.toString()), async (r) => {
    const url = r.request().url(), f = cache + '/' + createHash('md5').update(url).digest('hex');
    try {
      if (!existsSync(f)) writeFileSync(f, execFileSync('curl', ['-sfL', '--max-time', '20', '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', url]));
      await r.fulfill({ status: 200, body: readFileSync(f), headers: { 'content-type': url.includes('googleapis') ? 'text/css' : 'font/woff2', 'access-control-allow-origin': '*' } });
    } catch { await r.abort(); }
  });
  return { browser, page, errors };
}
