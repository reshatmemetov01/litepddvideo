// Сквозной тест бота без настоящего Telegram: поднимает поддельный Bot API и проходит весь диалог.
// node test/e2e-bot.mjs   (нужны ffmpeg и Chromium; рендер идёт в черновом качестве)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-bot-'));
const TOKEN = '123:test';

// 8 «фраз»: тоновые всплески с паузами по 1,4 с
const burst = (i) => ['-f', 'lavfi', '-i', `sine=f=${170 + i * 7}:d=1.3,tremolo=f=5:d=0.7`];
const gap = ['-f', 'lavfi', '-i', 'anoisesrc=d=1.4:c=pink:a=0.004'];
const parts = [];
const inputs = [];
for (let i = 0; i < 8; i++) { inputs.push(...burst(i), ...gap); parts.push(`[${i * 2}]`, `[${i * 2 + 1}]`); }
const voiceFile = path.join(work, 'voice8.wav');
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${parts.join('')}concat=n=16:v=0:a=1,volume=0.5[o]`, '-map', '[o]', '-ar', '44100', voiceFile]);

const files = { doc1: path.join(root, 'ready', 'q13_levo_svetofor.json'), v1: voiceFile, v2: voiceFile };
const calls = [];
const queue = [];
let msgId = 100;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url;
    const m = url.match(/^\/bot[^/]+\/(\w+)/);
    const send = (result) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
    if (!m) { // скачивание файла
      const id = url.split('/').pop().split('?')[0];
      const f = files[id];
      if (!f) { res.statusCode = 404; return res.end(); }
      return fs.createReadStream(f).pipe(res);
    }
    const method = m[1];
    const buf = Buffer.concat(chunks);
    const raw = buf.toString('utf8');
    let body = {};
    try { body = JSON.parse(raw); } catch { /* multipart */ }
    if (method !== 'getUpdates') calls.push({ method, raw: raw.slice(0, 20000), body, size: buf.length });
    const message = () => ({ message_id: ++msgId, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: 'private' }, text: body.text });
    switch (method) {
      case 'getMe': return send({ id: 999, is_bot: true, first_name: 'Test', username: 'testbot' });
      case 'getUpdates': {
        const off = body.offset ?? 0;
        const take = () => queue.filter((u) => u.update_id >= off);
        const t0 = Date.now();
        const poll = () => {
          const u = take();
          if (u.length || Date.now() - t0 > 800) return send(u);
          setTimeout(poll, 100);
        };
        return poll();
      }
      case 'getFile': return send({ file_id: body.file_id, file_path: `files/${body.file_id}` });
      case 'deleteWebhook': case 'answerCallbackQuery': case 'deleteMessage': return send(true);
      default: return send(message());
    }
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

const bot = spawn('node', ['src/bot/bot.mjs'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true,   // своя группа процессов: при завершении гасим и Chromium/ffmpeg рендера
  env: { ...process.env, BOT_TOKEN: TOKEN, ALLOWED_IDS: '1', TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`, DATA_DIR: path.join(work, 'data'), RENDER_QUALITY: 'draft', RENDER_WORKERS: '3' },
});
let botLog = '';
bot.stdout.on('data', (d) => (botLog += d));
bot.stderr.on('data', (d) => { botLog += d; process.stderr.write(d); });

let uid = 1000;
const from = { id: 1, is_bot: false, first_name: 'Tester' };
const chat = { id: 1, type: 'private' };
const pushMsg = (extra) => queue.push({ update_id: ++uid, message: { message_id: ++msgId, from, chat, date: Math.floor(Date.now() / 1000), ...extra } });
const pushCb = (data) => queue.push({ update_id: ++uid, callback_query: { id: String(uid), from, chat_instance: 'x', data, message: { message_id: msgId, chat, date: 1 } } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, label, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const c = calls.find(pred);
    if (c) return c;
    await sleep(200);
  }
  throw new Error(`Не дождались: ${label}\n--- лог бота ---\n${botLog.slice(-1500)}`);
}
const has = (method, text) => (c) => c.method === method && (c.raw.includes(text) || JSON.stringify(c.body).includes(text));
const count = (method) => calls.filter((c) => c.method === method).length;

let failed = false;
const check = (ok, label) => { console.log(ok ? '  ✓' : '  ✗', label); if (!ok) failed = true; };

try {
  await waitFor(() => botLog.includes('запущен'), 'запуск бота', 15000);
  console.log('1. /start');
  queue.push({ update_id: ++uid, message: { message_id: ++msgId, from, chat, date: 1, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } });
  await waitFor(has('sendMessage', 'Привет'), 'приветствие');
  check(true, 'бот поздоровался');

  console.log('2. Создать видео → сценарий');
  pushMsg({ text: '🎬 Создать видео' });
  await waitFor(has('sendMessage', 'Пришлите сценарий'), 'просьба прислать сценарий');
  pushMsg({ document: { file_id: 'doc1', file_name: 'q13.json', mime_type: 'application/json' } });
  await waitFor(has('sendMessage', 'Фразы для озвучки (8)'), 'разбор сценария');
  check(true, 'сценарий принят, 8 фраз');

  console.log('3. Голосовое → обработка → ждём подтверждения');
  pushMsg({ voice: { file_id: 'v1', duration: 30, mime_type: 'audio/ogg' } });
  const v1 = await waitFor((c) => c.method === 'sendVoice', 'очищенный голос с кнопками', 60000);
  const okData = v1.raw.match(/"callback_data":"(ok:[^"]+)"/)?.[1];
  const reData = v1.raw.match(/"callback_data":"(voice:[^"]+)"/)?.[1];
  check(!!okData && !!reData, `кнопки «Всё хорошо» и «Перезаписать» есть (${okData})`);
  await sleep(3000);
  check(count('sendVideo') === 0 && !calls.some(has('editMessageText', 'Рендерю')) && !calls.some(has('sendMessage', 'Начинаю рендер')), 'рендер НЕ стартовал без подтверждения');

  console.log('4. Перезапись: новая запись заменяет прежнюю');
  pushCb(reData);
  await waitFor((c) => c.method === 'sendMessage' && c.raw.includes('Запишите голосовое'), 'просьба записать снова');
  pushMsg({ voice: { file_id: 'v2', duration: 30, mime_type: 'audio/ogg' } });
  await waitFor(() => count('sendVoice') === 2, 'второй голос на проверку', 60000);
  check(true, 'после перезаписи бот снова просит подтверждение');
  check(count('sendVideo') === 0, 'рендера всё ещё нет');

  console.log('5. Подтверждение → рендер → видео');
  pushCb(okData);
  await waitFor((c) => c.method === 'sendMessage' && (c.raw.includes('Начинаю рендер') || c.raw.includes('В очереди')), 'старт рендера');
  check(true, 'после «Всё хорошо» пошёл рендер');
  pushCb(okData);   // двойное нажатие не должно ставить второй рендер
  const video = await waitFor((c) => c.method === 'sendVideo', 'готовое видео', 300000);
  check(video.size > 100000, `видео отправлено (${(video.size / 1024).toFixed(0)} КБ)`);
  await sleep(1500);
  check(count('sendVideo') === 1, 'видео одно (повторное нажатие не создало второй рендер)');

  const jobsDir = path.join(work, 'data', 'jobs');
  const leftovers = fs.readdirSync(jobsDir).flatMap((j) => (fs.existsSync(path.join(jobsDir, j)) ? fs.readdirSync(path.join(jobsDir, j)) : [])).filter((f) => /^raw\./.test(f));
  check(leftovers.length === 0, 'сырая запись голоса удалена с диска');
} catch (e) {
  console.error('\nОШИБКА:', e.message);
  failed = true;
} finally {
  try { process.kill(-bot.pid, 'SIGKILL'); } catch { bot.kill('SIGKILL'); }
  await sleep(300);
  server.close();
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(failed ? '\nТЕСТ НЕ ПРОЙДЕН' : '\nТЕСТ ПРОЙДЕН');
process.exit(failed ? 1 : 0);
