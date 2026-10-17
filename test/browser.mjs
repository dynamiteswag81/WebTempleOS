// Boot WebTempleOS in a real browser (Playwright's Chromium) through
// server.cjs; print the status line and save build/browser.png.
//   node test/browser.mjs [-secs=60] [-type=TEXT -typeat=S] [-reload [-type2=TEXT]]
// Playwright is not a dependency: set PLAYWRIGHT to its module dir if it
// is not in a global node_modules.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`-${n}=`)); return a ? a.slice(n.length + 2) : d; };
import { SCANCODES, charScan } from '../runtime/ps2.js';
const require = createRequire(import.meta.url);
const CODE = Object.fromEntries(Object.entries(SCANCODES).map(([k, v]) => [v, k]));
// type like a keyboard: physical keys, Shift held for shifted chars
async function typeKeys(page, text) {
  for (const ch of text) {
    const k = charScan(ch);
    if (!k) continue;
    await page.keyboard.press((k[1] ? 'Shift+' : '') + CODE[k[0]]);
    await page.waitForTimeout(20);
  }
}
const cands = [process.env.PLAYWRIGHT, '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean);
const { chromium } = require(cands.find((p) => fs.existsSync(p)) || 'playwright');
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

const port = 8000 + Math.floor(Math.random() * 900);
const srv = spawn(process.execPath, [path.join(root, 'server.cjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({ executablePath: exe, args: ['--enable-features=WebAssemblyJSPromiseIntegration'] });
const ctx = await browser.newContext({ viewport: { width: 1340, height: 1100 } });
const page = await ctx.newPage();
page.on('console', (m) => console.log('console:', m.text()));
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const secs = +arg('secs', 60);
const run = async (label, text) => {
  await page.goto(`http://localhost:${port}/`);
  await page.click('#screen');
  if (text) {
    await page.waitForTimeout(+arg('typeat', secs / 2) * 1000);
    await typeKeys(page, text.replace(/\\n/g, '\n'));
    await page.waitForTimeout((secs - +arg('typeat', secs / 2)) * 1000);
  } else await page.waitForTimeout(secs * 1000);
  if (arg('mouse', null) && !label) { // -mouse=x,y: move there (page px) and click
    const [x, y] = arg('mouse').split(',').map(Number);
    await page.mouse.move(x, y, { steps: 20 }); await page.waitForTimeout(300);
    await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up(); await page.waitForTimeout(2000);
  }
  console.log(`${label} status:`, await page.textContent('#status'));
  await page.screenshot({ path: path.join(root, 'build', `browser${label}.png`) });
};
try {
  await run('', arg('type', null));
  if (process.argv.includes('-reload')) await run('2', arg('type2', null));
} finally {
  await browser.close();
  srv.kill();
}
