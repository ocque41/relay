#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// web-to-video :: deterministic frame capture + ffmpeg encode
//
// Drives headless Chrome through every frame of a deterministic render route
// (e.g. /render?t=12.3 → mounts the animation at exactly t=12.3s), screenshots
// each frame as a PNG, then encodes a high-quality H.264 MP4 with ffmpeg.
//
// Usage:
//   1) start the dev server in another terminal: PORT=3030 npm run dev
//   2) node scripts/render-video.mjs [flags]
//
// Flags:
//   --fps        capture framerate          [default 30]
//   --duration   total seconds              [default 60]
//   --url        dev server base URL        [default http://localhost:3000]
//   --route      render route on the host   [default /render]
//   --param      query-param name for time  [default t]
//   --width      viewport + screenshot W    [default 1920]
//   --height     viewport + screenshot H    [default 1080]
//   --out        final mp4 path             [default tmp/video.mp4]
//   --keep       keep frames after encode   [default false]
//   --crf        x264 CRF                   [default 14]
//
// All three deliverables (no-audio MP4 for QuickTime, silent-AAC MP4 for web,
// ProRes 422 HQ master) are produced and copied to ~/Downloads/. Override the
// names by passing --name <basename> (defaults to the --out filename stem).
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ── arg parser ──────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, cur, i, all) => {
    if (cur.startsWith('--')) {
      const next = all[i + 1];
      pairs.push([cur.slice(2), next && !next.startsWith('--') ? next : true]);
    }
    return pairs;
  }, []),
);

const FPS      = Number.parseInt(String(args.fps      ?? 30), 10);
const DURATION = Number.parseFloat(String(args.duration ?? 60));
const BASE     = String(args.url      ?? 'http://localhost:3000');
const ROUTE    = String(args.route    ?? '/render');
const PARAM    = String(args.param    ?? 't');
const WIDTH    = Number.parseInt(String(args.width  ?? 1920), 10);
const HEIGHT   = Number.parseInt(String(args.height ?? 1080), 10);
const CRF      = Number.parseInt(String(args.crf    ?? 14), 10);
const KEEP     = Boolean(args.keep);
const OUT      = path.resolve(ROOT, String(args.out ?? 'tmp/video.mp4'));
const NAME     = String(args.name ?? path.basename(OUT, path.extname(OUT)));

const FRAMES_DIR = path.resolve(ROOT, `tmp/${NAME}-frames`);
const TOTAL = Math.round(FPS * DURATION);
const PADW  = String(TOTAL - 1).length;

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const DOWNLOADS = path.join(os.homedir(), 'Downloads');

console.log(`[render] ${WIDTH}×${HEIGHT} @ ${FPS}fps · ${DURATION}s · ${TOTAL} frames`);
console.log(`[render] route   = ${BASE}${ROUTE}?${PARAM}=<t>`);
console.log(`[render] frames  → ${FRAMES_DIR}`);
console.log(`[render] mp4     → ${OUT}`);
console.log(`[render] deliver → ${DOWNLOADS}/`);

// ── prepare dirs ────────────────────────────────────────────────────────────
if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true, force: true });
mkdirSync(FRAMES_DIR, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });

// ── chrome ──────────────────────────────────────────────────────────────────
console.log('[render] launching chrome …');
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--font-render-hinting=none',     // critical: stable text between frames
    '--force-color-profile=srgb',     // critical: deterministic color
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
page.setDefaultNavigationTimeout(60_000);
page.setDefaultTimeout(30_000);

// Hide common dev overlays on every page load (belt-and-braces).
const HIDE_DEV_CSS = `
  nextjs-portal,
  [data-nextjs-toast],
  [data-nextjs-dev-indicator],
  [data-nextjs-dev-overlay],
  #__next-build-watcher,
  #nextjs__container_build_error_label,
  div[data-nextjs-route-announcer],
  vite-plugin-checker-error-overlay,
  vite-error-overlay,
  #vite-plugin-checker-error-overlay {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
`;
await page.evaluateOnNewDocument((css) => {
  const apply = () => {
    const id = '__hide_dev_overlays';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  apply();
}, HIDE_DEV_CSS);

// Warm up so fonts cache.
console.log('[render] warming up …');
await page.goto(`${BASE}${ROUTE}?${PARAM}=0`, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);

// ── frame loop ──────────────────────────────────────────────────────────────
const start = Date.now();
for (let i = 0; i < TOTAL; i++) {
  const t = (i / FPS).toFixed(4);
  await page.goto(`${BASE}${ROUTE}?${PARAM}=${t}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  // Wait for the page to flip __frameReady — set by your render route in a
  // double-RAF effect after layout settles.
  await page.waitForFunction(
    () => (window).__frameReady === true,
    { timeout: 10_000 },
  ).catch(() => {/* non-fatal: some routes don't set it; we still proceed */});

  const file = path.join(FRAMES_DIR, `f_${String(i).padStart(PADW, '0')}.png`);
  await page.screenshot({
    path: file,
    type: 'png',
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    omitBackground: false,
  });

  if (i % 30 === 0 || i === TOTAL - 1) {
    const pct = ((i + 1) / TOTAL) * 100;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r[render] frame ${i + 1}/${TOTAL} (${pct.toFixed(1)}%) · ${elapsed}s`);
  }
}
process.stdout.write('\n');
await browser.close();

// ── encode (3 deliverables in one pass) ─────────────────────────────────────
const ff = (args, label) =>
  new Promise((resolve, reject) => {
    console.log(`[render] ffmpeg → ${label}`);
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${label} exited ${code}`))
    );
  });

const inputPattern = path.join(FRAMES_DIR, `f_%0${PADW}d.png`);
const cleanMp4   = path.join(DOWNLOADS, `${NAME}.mp4`);
const webMp4     = path.join(DOWNLOADS, `${NAME}-web.mp4`);
const masterMov  = path.join(DOWNLOADS, `${NAME}-MASTER.mov`);

// A) macOS-clean H.264 — no audio. The "double-click" deliverable.
await ff([
  '-y',
  '-framerate', String(FPS),
  '-i', inputPattern,
  '-c:v', 'libx264',
  '-preset', 'slow',
  '-crf', String(CRF),
  '-profile:v', 'main',
  '-level', '4.0',
  '-pix_fmt', 'yuv420p',
  '-aspect', '16:9',
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-colorspace', 'bt709',
  '-movflags', '+faststart',
  '-metadata', `title=${NAME}`,
  '-r', String(FPS),
  cleanMp4,
], 'clean H.264 (no audio)');

// B) Web H.264 with silent AAC track for video tag compatibility.
await ff([
  '-y',
  '-framerate', String(FPS),
  '-i', inputPattern,
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-shortest',
  '-c:v', 'libx264',
  '-preset', 'slow',
  '-crf', String(Math.max(CRF, 18)),
  '-profile:v', 'high',
  '-level', '4.1',
  '-pix_fmt', 'yuv420p',
  '-aspect', '16:9',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000',
  '-movflags', '+faststart',
  '-r', String(FPS),
  webMp4,
], 'web H.264 (with silent AAC)');

// C) ProRes 422 HQ master — for editing / re-encode.
await ff([
  '-y',
  '-framerate', String(FPS),
  '-i', inputPattern,
  '-c:v', 'prores_ks',
  '-profile:v', '3',                  // 3 = HQ
  '-pix_fmt', 'yuv422p10le',
  '-vendor', 'apl0',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  '-r', String(FPS),
  masterMov,
], 'ProRes 422 HQ master');

// Also place the original requested OUT (mirrors the clean variant).
mkdirSync(path.dirname(OUT), { recursive: true });
copyFileSync(cleanMp4, OUT);

// Strip macOS provenance/quarantine xattrs.
await new Promise((resolve) => {
  const p = spawn('xattr', ['-c', cleanMp4, webMp4, masterMov, OUT], { stdio: 'inherit' });
  p.on('exit', () => resolve());
});

if (!KEEP) {
  rmSync(FRAMES_DIR, { recursive: true, force: true });
}

console.log('\n[render] done');
console.log('[render] deliverables in ~/Downloads/:');
console.log(`         ${path.basename(cleanMp4)}    ← double-click this`);
console.log(`         ${path.basename(webMp4)}    ← for <video> embeds`);
console.log(`         ${path.basename(masterMov)}    ← ProRes master`);
console.log(`[render] also at: ${OUT}`);
