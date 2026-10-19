// Рендер сценария в mp4: node src/render.mjs scenarios/q01.json [--preview] [--frames 0,5,12] [--fps 30]
// --preview  → 540x960, иначе 1080x1920
// --frames   → только PNG-кадры в out/frames/ (для быстрой отладки сцены)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const scenarioPath = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : (args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[i + 1]); };
if (!scenarioPath) { console.error('Укажите сценарий: node src/render.mjs scenarios/q01.json'); process.exit(1); }

const preview = !!flag('preview', false);
const fps = +flag('fps', 30);
const [W, H] = preview ? [540, 960] : [1080, 1920];
const scenario = JSON.parse(fs.readFileSync(path.join(root, scenarioPath), 'utf8'));
const name = path.basename(scenarioPath, '.json');

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', mime[path.extname(p)] ?? 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('requestfailed', (r) => console.error('[fail]', r.url()));
page.on('response', (r) => { if (r.status() >= 400) console.error('[http ' + r.status() + ']', r.url()); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://localhost:${port}/src/web/index.html?scenario=${encodeURIComponent(scenarioPath)}&w=${W}&h=${H}`);
await page.waitForFunction('window.ready === true', null, { timeout: 60000 });
const duration = await page.evaluate('window.duration');

const outDir = path.join(root, 'out');
fs.mkdirSync(outDir, { recursive: true });

const only = flag('frames', null);
if (only) {
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
  for (const t of String(only).split(',').map(Number)) {
    await page.evaluate((t) => window.renderAt(t), t);
    await page.screenshot({ path: path.join(outDir, 'frames', `${name}_${String(t).replace('.', '_')}.png`) });
    console.log('кадр t=' + t);
  }
} else {
  const silent = path.join(outDir, `${name}.silent.mp4`);
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', preview ? 'veryfast' : 'medium', '-crf', preview ? '24' : '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(duration * fps);
  const t0 = Date.now();
  for (let f = 0; f < total; f++) {
    await page.evaluate((t) => window.renderAt(t), f / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 93 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 30 === 0) process.stdout.write(`\rкадр ${f}/${total}  (${((Date.now() - t0) / 1000).toFixed(0)} c)`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('\nбез звука:', silent);

  // озвучка: если рядом лежит audio/<name>.(mp3|wav|m4a), подмешиваем её
  const audio = ['mp3', 'wav', 'm4a'].map((e) => path.join(root, 'audio', `${name}.${e}`)).find((p) => fs.existsSync(p));
  const final = path.join(outDir, `${name}.mp4`);
  if (audio) {
    await new Promise((res, rej) => spawn('ffmpeg', ['-y', '-v', 'error', '-i', silent, '-i', audio, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', final], { stdio: 'inherit' }).on('close', (c) => (c ? rej(new Error('ffmpeg mux')) : res())));
    console.log('со звуком:', final);
  } else {
    fs.copyFileSync(silent, final);
    console.log('озвучки нет (положите audio/' + name + '.mp3) →', final);
  }
}
await browser.close();
server.close();
