// Build dist/: index.html + game.js (three.js bundled in, minified) + ui.css + hud.css.
//   node tools/build.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { createHash } from 'crypto';
mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', minify: true, sourcemap: false, outfile: 'dist/game.js', target: 'es2020', legalComments: 'none' });
copyFileSync('src/ui/ui.css', 'dist/ui.css');
copyFileSync('src/ui/hud.css', 'dist/hud.css');
const v = createHash('md5').update(readFileSync('dist/game.js')).update(readFileSync('dist/ui.css')).update(readFileSync('dist/hud.css')).digest('hex').slice(0, 10);
let html = readFileSync('index.html', 'utf8');
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\n?/, '');
html = html.replace('src="src/main.js"', `src="game.js?v=${v}"`)
  .replace('href="src/ui/ui.css"', `href="ui.css?v=${v}"`).replace('href="src/ui/hud.css"', `href="hud.css?v=${v}"`);
if (html.includes('src/')) throw new Error('dist/index.html still references src/');
writeFileSync('dist/index.html', html);
console.log('built dist/ v=' + v, (readFileSync('dist/game.js').length / 1024).toFixed(0) + 'K');
