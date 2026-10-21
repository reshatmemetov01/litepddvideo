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
import { mixAudio } from './music.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SIZES = { draft: [540, 960], hd: [720, 1280], fhd: [1080, 1920] };
// качество картинки: ss — рендер в ss раз крупнее со сжатием (гладкие края), post — эффекты
export const LOOKS = {
  draft: { ss: 1, fps: 15, post: { bloom: false, dof: false, ao: false } },   // черновик: проверить сцену, плавность не важна
  // AO (затенение в углах) даёт +60% ко времени кадра — по умолчанию выключено (RENDER_AO=1 включает)
  hd: { ss: 1.5, post: { bloom: true, dof: true, ao: false } },
  fhd: { ss: 1.5, post: { bloom: true, dof: true, ao: false } },
};

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
 * @param {string} [o.music]    фоновая музыка (тихо, под голосом)
 * @param {'draft'|'hd'|'fhd'} [o.quality]
 * @param {string} o.out        путь к итоговому mp4
 * @param {number[]} [o.onlyFrames] только эти моменты (сек) в PNG рядом с out
 */
export async function renderScenario({ scenario, durations, audio, music, quality = 'hd', out, workers, fps: fpsArg, onProgress, onlyFrames, limitFrames, range, timeoutMs = 4 * 3600 * 1000 }) {
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
  const look = structuredClone(LOOKS[quality] ?? LOOKS.hd);
  const fps = +process.env.RENDER_FPS || fpsArg || look.fps || 30;
  if (process.env.RENDER_AO) look.post.ao = process.env.RENDER_AO === '1';
  if (process.env.RENDER_SS) look.ss = +process.env.RENDER_SS;
  if (process.env.RENDER_POST) Object.assign(look.post, JSON.parse(process.env.RENDER_POST));   // для замеров: {"dof":false}
  // программная видеокарта (SwiftShader) сама занимает все ядра: в качественном режиме вторая вкладка
  // только мешает (замер: 4,1 с/кадр одна против 9,3 с/кадр на каждую из двух). В черновике — 2 вкладки.
  const auto = look.ss > 1 || look.post.dof ? 1 : 2;
  const n = Math.max(1, workers ?? (+process.env.RENDER_WORKERS || auto));
  // экономия памяти на серверах до 6 ГБ: карта теней 2048 вместо 4096 и сглаживание 1,25 вместо 1,5
  // (пик памяти браузера ~1,8 ГБ → ~1,2 ГБ); RENDER_LOWMEM=0 — выключить
  const lowMem = process.env.RENDER_LOWMEM ? process.env.RENDER_LOWMEM === '1' : os.totalmem() < 6 * 2 ** 30;
  if (lowMem) { look.ss = Math.min(look.ss, 1.25); look.shadow = 2048; }
  const launch = () => chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  let browser = await launch();
  const silent = out.replace(/\.mp4$/, '') + '.silent.mp4';
  // защита от зависания: по истечении времени закрываем браузер, рендер падает с ошибкой
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; browser.close().catch(() => {}); }, timeoutMs);
  let ffRef = null;
  const openPage = async () => {
    if (!browser.isConnected()) browser = await launch();
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    page.on('crash', () => { page.crashed = true; console.error('[render] вкладка упала (чаще всего — не хватило памяти)'); });
    await page.goto(`http://127.0.0.1:${port}/src/web/index.html?scenario=${encodeURIComponent(scenarioRel)}&w=${W}&h=${H}&opts=${encodeURIComponent(JSON.stringify(look))}`, { waitUntil: 'commit', timeout: 120000 });
    // сцена грузит модели и текстуры сама; на слабом сервере это может занять несколько минут
    await page.waitForFunction('window.ready === true || window.loadError', null, { timeout: 15 * 60000 });
    const loadError = await page.evaluate('window.loadError');
    if (loadError) throw new Error('Сцена не загрузилась: ' + loadError);
    return page;
  };
  // кадр с повтором: если вкладка или браузер упали, открываем сцену заново и снимаем этот же кадр
  let restarts = 0;
  const shoot = async (slot, pages, t, opts) => {
    for (;;) {
      try {
        await pages[slot].evaluate((t) => window.renderAt(t), t);
        return await pages[slot].screenshot(opts);
      } catch (e) {
        // упавшая вкладка не отвечает: снимок ждёт до таймаута — это тоже повод перезапустить
        const dead = pages[slot].crashed || !browser.isConnected() || /closed|crash|Target|disconnected/i.test(e.message);
        if (timedOut || !dead || restarts >= 3) throw e;
        restarts++;
        console.error(`[render] браузер упал на t=${t.toFixed(2)} с, перезапуск ${restarts}/3:`, e.message.split('\n')[0]);
        await pages[slot].close().catch(() => {});
        pages[slot] = await openPage();
      }
    }
  };
  try {
    const pages = [];
    for (let i = 0; i < (onlyFrames ? 1 : n); i++) pages.push(await openPage());

    if (onlyFrames) {
      const base = out.replace(/\.mp4$/, '');
      for (const t of onlyFrames) {
        const t0 = Date.now();
        await shoot(0, pages, t, { path: `${base}_t${String(t).replace('.', '_')}.png` });
        if (process.env.RENDER_TIMING && t === onlyFrames[0]) console.log('город:', JSON.stringify(await pages[0].evaluate('window.__cityStats')));
        if (process.env.RENDER_TIMING) console.log(`кадр t=${t}: ${((Date.now() - t0) / 1000).toFixed(1)} c (с учётом снимка)`, JSON.stringify(await pages[0].evaluate('window.__renderInfo')));
      }
      return { out: null, duration: resolved.duration };
    }

    // range: [с, по] в секундах — отрендерить только кусок (для быстрого просмотра, без звука)
    const first = range ? Math.round(range[0] * fps) : 0;
    const total = range ? Math.round((range[1] - range[0]) * fps) : limitFrames ?? Math.round(resolved.duration * fps);
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
        onProgress?.({ frame: written, total, seconds: (Date.now() - t0) / 1000 });
      }
    };
    await Promise.all(pages.map(async (_, slot) => {
      while (true) {
        if (next >= total) return;
        if (next - written > LOOKAHEAD) { await new Promise((r) => setTimeout(r, 20)); continue; }
        const f = next++;
        ready.set(f, await shoot(slot, pages, (first + f) / fps, { type: 'jpeg', quality: 93 }));
        await flush();
      }
    }));
    await flush();
    ff.stdin.end();
    await ffDone;

    // музыку можно отключить для отдельного ролика: "music": false в сценарии
    const bg = scenario.music === false ? null : music;
    if (!range && (audio || bg)) {
      await mixAudio({ video: silent, voice: audio, music: bg, duration: resolved.duration, out });
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
