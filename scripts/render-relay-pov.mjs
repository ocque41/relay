#!/usr/bin/env node
// Render the Relay POV Demo (handed off as a Babel-in-browser HTML bundle)
// to a deterministic MP4. Loads tmp/relay-pov/source/render.html ONCE,
// then drives window.setRenderTime(t) for every frame — no per-frame
// navigation, much faster, and no ERR_ABORTED races.
//
// Usage:
//   1) start the static server:
//        python3 -m http.server 8765 --bind 127.0.0.1 \
//          --directory tmp/relay-pov/source
//   2) node scripts/render-relay-pov.mjs [--fps 30] [--duration 66.5]
//
// Output: tmp/relay-pov/relay-pov-1080p30.mp4 (web-distributable H.264).
// Companion encodes (QuickTime-clean MP4 + ProRes master) come from
// scripts/encode-relay-pov-variants.sh once frames are on disk.

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, cur, i, all) => {
    if (cur.startsWith('--')) {
      const next = all[i + 1];
      pairs.push([cur.slice(2), next && !next.startsWith('--') ? next : true]);
    }
    return pairs;
  }, []),
);

const FPS = Number.parseInt(String(args.fps ?? 30), 10);
const DURATION = Number.parseFloat(String(args.duration ?? 66.5));
const BASE_URL = String(args.url ?? 'http://localhost:8765');
const ROUTE = String(args.route ?? '/render.html');
const OUT = path.resolve(ROOT, String(args.out ?? 'tmp/relay-pov/relay-pov-1080p30.mp4'));
const FRAMES_DIR = path.resolve(ROOT, 'tmp/relay-pov/frames');
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TOTAL_FRAMES = Math.round(FPS * DURATION);
const padWidth = String(TOTAL_FRAMES - 1).length;

console.log(
  `[render] fps=${FPS} duration=${DURATION}s totalFrames=${TOTAL_FRAMES} url=${BASE_URL}${ROUTE}`,
);
console.log(`[render] frames → ${FRAMES_DIR}`);
console.log(`[render] mp4    → ${OUT}`);

if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true, force: true });
mkdirSync(FRAMES_DIR, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--font-render-hinting=none',
    '--force-color-profile=srgb',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.setDefaultNavigationTimeout(60_000);
page.setDefaultTimeout(30_000);

page.on('pageerror', (err) => console.error('[pageerror]', err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error' && !msg.text().includes('favicon')) {
    console.error('[console.error]', msg.text());
  }
});

console.log('[render] loading once …');
await page.goto(`${BASE_URL}${ROUTE}`, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);

// Wait until React mounted and exposed the setter, then for the initial
// __frameReady that the FilmFrame raises after fonts settle.
await page.waitForFunction(
  () => typeof window.setRenderTime === 'function',
  { timeout: 30_000 },
);
await page.waitForFunction(() => window.__frameReady === true, { timeout: 30_000 });

const start = Date.now();
let lastLogged = -1;

for (let i = 0; i < TOTAL_FRAMES; i++) {
  const t = i / FPS;

  // Drive the playhead and wait for the next two-RAF settle.
  await page.evaluate((tt) => window.setRenderTime(tt), t);
  await page.waitForFunction(() => window.__frameReady === true, {
    timeout: 10_000,
    polling: 'raf',
  });

  const file = path.join(
    FRAMES_DIR,
    `f_${String(i).padStart(padWidth, '0')}.png`,
  );
  await page.screenshot({
    path: file,
    type: 'png',
    clip: { x: 0, y: 0, width: 1920, height: 1080 },
    omitBackground: false,
  });

  if (i % 30 === 0 || i === TOTAL_FRAMES - 1) {
    const pct = ((i + 1) / TOTAL_FRAMES) * 100;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const fps = ((i + 1) / Math.max(0.001, (Date.now() - start) / 1000)).toFixed(1);
    process.stdout.write(
      `\r[render] frame ${i + 1}/${TOTAL_FRAMES} (${pct.toFixed(1)}%) · ${elapsed}s · ${fps} fps capture`,
    );
    lastLogged = i;
  }
}
process.stdout.write('\n');
await browser.close();

console.log('[render] encoding 1080p30 H.264 web variant …');

const ffArgs = [
  '-y',
  '-framerate', String(FPS),
  '-i', path.join(FRAMES_DIR, `f_%0${padWidth}d.png`),
  '-f', 'lavfi',
  '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-shortest',
  '-c:v', 'libx264',
  '-preset', 'slow',
  '-crf', '18',
  '-profile:v', 'high',
  '-level', '4.1',
  '-pix_fmt', 'yuv420p',
  '-aspect', '16:9',
  '-c:a', 'aac',
  '-b:a', '96k',
  '-ac', '2',
  '-ar', '48000',
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-colorspace', 'bt709',
  '-movflags', '+faststart',
  '-r', String(FPS),
  OUT,
];

await new Promise((resolve, reject) => {
  const ff = spawn('ffmpeg', ffArgs, { stdio: 'inherit' });
  ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
});

console.log(`[render] done → ${OUT}`);
