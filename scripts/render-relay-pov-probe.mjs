#!/usr/bin/env node
// Sanity probe — load render.html once, then sample 5 timestamps via
// window.setRenderTime(t) and screenshot each. Confirms the
// single-load drive path works before launching the full capture.
import puppeteer from 'puppeteer-core';

const SAMPLES = [1.5, 10, 25, 40, 55, 64.5];
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  args: [
    '--no-sandbox',
    '--hide-scrollbars',
    '--font-render-hinting=none',
    '--force-color-profile=srgb',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error' && !msg.text().includes('favicon')) {
    console.error('[console.error]', msg.text());
  }
});

await page.goto('http://localhost:8765/render.html', { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => typeof window.setRenderTime === 'function', { timeout: 30_000 });
await page.waitForFunction(() => window.__frameReady === true, { timeout: 30_000 });

for (const t of SAMPLES) {
  await page.evaluate((tt) => window.setRenderTime(tt), t);
  await page.waitForFunction(() => window.__frameReady === true, { timeout: 10_000, polling: 'raf' });
  const out = `/tmp/relay-pov-probe-${t}.png`;
  await page.screenshot({ path: out, type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  console.log(`[probe] t=${t}s → ${out}`);
}
await browser.close();
