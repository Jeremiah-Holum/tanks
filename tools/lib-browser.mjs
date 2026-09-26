// Shared helpers for the headless-browser tools (verify, shot-game): dev server on 8477 (started
// and stopped here when nothing is listening), Chromium with SwiftShader, Google Fonts served
// through curl (headless Chrome can't use the sandbox proxy), console/page error collection.
// Always run the tools through tools/capped.sh (one browser on the machine at a time).
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

export const PORT = +(process.env.SF_PORT || 8477);
const external = (u) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:');
const fonts = (u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u);

async function listening() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`); return r.ok; } catch { return false; }
}
export async function startServer() {
  if (await listening()) return null;
  const root = fileURLToPath(new URL('..', import.meta.url));
  // python3 when it works; otherwise (Windows without Python) a tiny node static server
  let p = null;
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); p = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' }); } catch { p = null; }
  if (!p) p = spawn(process.execPath, ['-e', NODE_SERVER, String(PORT)], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 100));
  return p;
}

const NODE_SERVER = `const http=require('http'),fs=require('fs'),path=require('path');const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ogg':'audio/ogg','.wav':'audio/wav','.jpg':'image/jpeg','.woff2':'font/woff2'};
http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);let f=path.join(process.cwd(),path.normalize(u));if(!f.startsWith(process.cwd())){r.writeHead(403);return r.end();}
if(u.endsWith('/')){const i=path.join(f,'index.html');if(fs.existsSync(i))f=i;else{let l=[];try{l=fs.readdirSync(f);}catch{r.writeHead(404);return r.end();}r.writeHead(200,{'Content-Type':'text/html'});return r.end(l.map((n)=>'<a href="'+encodeURIComponent(n)+'">'+n+'</a> ').join(''));}}
fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);return r.end();}r.writeHead(200,{'Content-Type':T[path.extname(f)]||'application/octet-stream','Cache-Control':'no-cache'});r.end(d);});}).listen(+process.argv[1],'127.0.0.1');`;

// Playwright's own Chromium; if it isn't installed, the system Chrome / Edge (SF_CHANNEL=chrome|msedge to force one).
async function launch(opts) {
  if (process.env.SF_CHANNEL) return chromium.launch({ ...opts, channel: process.env.SF_CHANNEL });
  try { return await chromium.launch(opts); } catch (e) {
    for (const channel of ['chrome', 'msedge']) { try { return await chromium.launch({ ...opts, channel }); } catch { /* next */ } }
    throw e;
  }
}

export async function openBrowser({ w = 1280, h = 720 } = {}) {
  const browser = await launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
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
