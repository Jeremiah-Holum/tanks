import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('console', (m) => console.log('console', m.text()));
  await page.goto('http://127.0.0.1:8477/tools/lab-tanks.html?' + process.argv[2]);
  await page.waitForFunction(() => window.__lab && window.__lab.done, null, { timeout: 120000 });
  console.log(await page.evaluate(process.argv[3]));
} finally { await browser.close(); }
