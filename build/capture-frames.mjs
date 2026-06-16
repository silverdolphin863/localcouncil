// Capture animation frames by spawning headless Chrome at incrementing
// virtual-time budgets, then ffmpeg-encode them to a Twitter-friendly MP4.
// No npm deps; only uses already-installed chrome and ffmpeg.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const FRAMES_DIR = join(HERE, 'frames');
const HOST_HTML = 'file:///' + join(HERE, 'poster.html').replace(/\\/g, '/');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FFMPEG = 'ffmpeg';

const FPS = 15;
const SECONDS = 12;
const FRAMES = FPS * SECONDS;

if (!existsSync(FRAMES_DIR)) mkdirSync(FRAMES_DIR, { recursive: true });
for (const f of readdirSync(FRAMES_DIR)) unlinkSync(join(FRAMES_DIR, f));

console.log(`Capturing ${FRAMES} frames @ ${FPS}fps...`);
const t0 = Date.now();
for (let i = 0; i < FRAMES; i++) {
  // Add 50ms buffer per frame so animation has settled before screenshot
  const budgetMs = Math.round(((i + 0.5) / FRAMES) * SECONDS * 1000);
  const out = join(FRAMES_DIR, `f-${String(i).padStart(4, '0')}.png`);
  const r = spawnSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--screenshot=${out}`,
    '--window-size=1280,720',
    `--virtual-time-budget=${budgetMs}`,
    HOST_HTML,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (r.status !== 0 || !existsSync(out)) {
    console.error(`frame ${i} failed (chrome status ${r.status})`);
    process.exit(1);
  }
  if (i % 10 === 0) process.stdout.write(`${i}.`);
}
console.log(`\ncaptured in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const mp4Out = join(HERE, '..', 'public', 'how-it-works.mp4');
const ffArgs = [
  '-y',
  '-framerate', String(FPS),
  '-i', join(FRAMES_DIR, 'f-%04d.png'),
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-vf', 'scale=1280:720',
  '-movflags', '+faststart',
  '-loop', '0',
  mp4Out,
];
console.log('Encoding MP4...');
const ff = spawnSync(FFMPEG, ffArgs, { stdio: 'inherit' });
if (ff.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }

const gifOut = join(HERE, '..', 'public', 'how-it-works.gif');
console.log('Encoding GIF...');
const gifArgs = [
  '-y',
  '-framerate', String(FPS),
  '-i', join(FRAMES_DIR, 'f-%04d.png'),
  '-vf', 'scale=900:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=sierra2_4a',
  '-loop', '0',
  gifOut,
];
const gif = spawnSync(FFMPEG, gifArgs, { stdio: 'inherit' });
if (gif.status !== 0) { console.error('gif failed'); process.exit(1); }

console.log(`done: ${mp4Out}, ${gifOut}`);
