// Boot WebTempleOS in a real browser (Playwright's Chromium) through
// server.cjs; print the status line and save build/browser.png.
//   node test/browser.mjs [-secs=60] [-type=TEXT -typeat=S] [-reload]
// Playwright is not a dependency: set PLAYWRIGHT to its module dir if it
// is not in a global node_modules.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`-${n}=`)); return a ? a.slice(n.length + 2) : d; };
const require = createRequire(import.meta.url);
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
const run = async (label) => {
  await page.goto(`http://localhost:${port}/`);
  await page.click('#screen');
  if (arg('type', null)) {
    await page.waitForTimeout(+arg('typeat', secs / 2) * 1000);
    await page.keyboard.type(arg('type').replace(/\\n/g, '\n'), { delay: 30 });
    await page.waitForTimeout((secs - +arg('typeat', secs / 2)) * 1000);
  } else await page.waitForTimeout(secs * 1000);
  console.log(`${label} status:`, await page.textContent('#status'));
  await page.screenshot({ path: path.join(root, 'build', `browser${label}.png`) });
};
try {
  await run('');
  if (process.argv.includes('-reload')) await run('2');
} finally {
  await browser.close();
  srv.kill();
}
