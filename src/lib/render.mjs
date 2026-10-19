// Рендер сценария в mp4. Используется и из CLI (src/render.mjs), и из бота.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateScenario } from './validate.mjs';
import { resolveScenario, estimateDuration } from './timeline.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SIZES = { draft: [540, 960], hd: [720, 1280], fhd: [1080, 1920] };

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff' };

function startServer() {
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', mime[path.extname(p)] ?? 'application/octet-stream');
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('close', (c) => (c ? reject(new Error(`${cmd} завершился с кодом ${c}`)) : resolve()));
});

/**
 * @param {object} o
 * @param {object} o.scenario   сценарий (с якорями времени)
 * @param {number[]} [o.durations] длительности фраз по записи голоса; без них оцениваются по тексту
 * @param {string} [o.audio]    готовая дорожка (wav) для подмешивания
 * @param {'draft'|'hd'|'fhd'} [o.quality]
 * @param {string} o.out        путь к итоговому mp4
 * @param {number[]} [o.onlyFrames] только эти моменты (сек) в PNG рядом с out
 */
export async function renderScenario({ scenario, durations, audio, quality = 'hd', out, workers, fps = 30, onProgress, onlyFrames, limitFrames, timeoutMs = 45 * 60 * 1000 }) {
  const errors = validateScenario(scenario);
  if (errors.length) throw Object.assign(new Error('Сценарий не прошёл проверку:\n• ' + errors.join('\n• ')), { errors });

  const dur = durations ?? scenario.voiceover.map((v) => estimateDuration(v.text));
  const resolved = resolveScenario(scenario, dur);
  const [W, H] = SIZES[quality] ?? SIZES.hd;

  const tmpDir = path.join(root, 'data', 'tmp');   // служебная папка страницы рендера, не путать с DATA_DIR
  fs.mkdirSync(tmpDir, { recursive: true });
  const id = `${process.pid}-${Date.now()}`;
  const scenarioRel = `data/tmp/${id}.json`;
  fs.writeFileSync(path.join(root, scenarioRel), JSON.stringify(resolved));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const server = await startServer();
  const port = server.address().port;
  // каждая вкладка ~0,5 ГБ: на 4 ГБ безопаснее 2, на большем объёме — до 3 (или RENDER_WORKERS)
  const auto = os.totalmem() < 6 * 2 ** 30 ? 2 : Math.min(3, Math.max(1, os.cpus().length - 1));
  const n = Math.max(1, workers ?? (+process.env.RENDER_WORKERS || auto));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const silent = out.replace(/\.mp4$/, '') + '.silent.mp4';
  // защита от зависания: по истечении времени закрываем браузер, рендер падает с ошибкой
  const watchdog = setTimeout(() => browser.close().catch(() => {}), timeoutMs);
  let ffRef = null;
  try {
    const pages = [];
    for (let i = 0; i < (onlyFrames ? 1 : n); i++) {
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      page.on('pageerror', (e) => console.error('[pageerror]', e.message));
      await page.goto(`http://127.0.0.1:${port}/src/web/index.html?scenario=${encodeURIComponent(scenarioRel)}&w=${W}&h=${H}`);
      await page.waitForFunction('window.ready === true', null, { timeout: 60000 });
      pages.push(page);
    }

    if (onlyFrames) {
      const base = out.replace(/\.mp4$/, '');
      for (const t of onlyFrames) {
        await pages[0].evaluate((t) => window.renderAt(t), t);
        await pages[0].screenshot({ path: `${base}_t${String(t).replace('.', '_')}.png` });
      }
      return { out: null, duration: resolved.duration };
    }

    const total = limitFrames ?? Math.round(resolved.duration * fps);
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', quality === 'draft' ? 'veryfast' : 'medium', '-crf', quality === 'fhd' ? '18' : '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent], { stdio: ['pipe', 'inherit', 'inherit'] });
    ffRef = ff;
    const ffDone = new Promise((r) => ff.on('close', r));

    // кадры снимаются параллельно вкладками, пишутся в ffmpeg строго по порядку
    const ready = new Map();
    let next = 0, written = 0;
    const LOOKAHEAD = n * 6;
    const t0 = Date.now();
    const flush = async () => {
      while (ready.has(written)) {
        const buf = ready.get(written); ready.delete(written);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
        written++;
        if (written % 15 === 0 || written === total) onProgress?.({ frame: written, total, seconds: (Date.now() - t0) / 1000 });
      }
    };
    await Promise.all(pages.map(async (page) => {
      while (true) {
        if (next >= total) return;
        if (next - written > LOOKAHEAD) { await new Promise((r) => setTimeout(r, 20)); continue; }
        const f = next++;
        await page.evaluate((t) => window.renderAt(t), f / fps);
        ready.set(f, await page.screenshot({ type: 'jpeg', quality: 93 }));
        await flush();
      }
    }));
    await flush();
    ff.stdin.end();
    await ffDone;

    if (audio) {
      await run('ffmpeg', ['-y', '-v', 'error', '-i', silent, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-t', String(resolved.duration), out]);
      fs.rmSync(silent, { force: true });
    } else {
      fs.renameSync(silent, out);
    }
    return { out, duration: resolved.duration, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    ffRef?.kill('SIGKILL');
    fs.rmSync(silent, { force: true });
    throw e;
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
    server.close();
    fs.rmSync(path.join(root, scenarioRel), { force: true });
  }
}
