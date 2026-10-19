// Тест озвучки через ElevenLabs: поддельные Telegram и ElevenLabs, проверка кэша, дублей и подтверждения.
// node test/e2e-tts.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-bot-'));
const TOKEN = '123:test';

const voiceFile = null;
const files = { doc1: path.join(root, 'ready', 'q13_levo_svetofor.json') };
const calls = [];
const elCalls = [];
const el = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url.startsWith('/v1/user/subscription')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ character_count: 1234, character_limit: 30000 })); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    elCalls.push({ url: req.url, key: req.headers['xi-api-key'], body });
    if (req.headers['xi-api-key'] !== 'testkey') { res.statusCode = 401; return res.end('{"detail":{"status":"invalid_api_key"}}'); }
    // «озвучка»: тон длиной пропорционально тексту, с тишиной по краям
    const d = Math.max(1, body.text.length * 0.06);
    const out = path.join(work, `el_${elCalls.length}.mp3`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=200:d=${d}`, '-af', 'adelay=300:all=1,apad=pad_dur=0.4,volume=0.5', '-c:a', 'libmp3lame', out]);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.end(fs.readFileSync(out));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => el.once('listening', r));
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
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BOT_TOKEN: TOKEN, ALLOWED_IDS: '1', TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`, ELEVENLABS_API_KEY: 'testkey', ELEVENLABS_VOICE_ID: 'voice123', ELEVENLABS_API_ROOT: `http://127.0.0.1:${el.address().port}`, DATA_DIR: path.join(work, 'data'), RENDER_QUALITY: 'draft', RENDER_WORKERS: '3' },
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

  console.log('3. Кнопка «Озвучить моим голосом» есть и показывает число символов');
  const scen = await waitFor(has('sendMessage', 'Озвучить моим голосом'), 'кнопка озвучки');
  const ttsData = scen.raw.match(/"callback_data":"(tts:[^"]+)"/)?.[1];
  check(!!ttsData && /симв\./.test(scen.raw), `кнопка есть (${ttsData})`);
  const chars = +scen.raw.match(/\((\d+) симв\./)[1];
  check(chars > 300 && chars < 450, `число символов разумное: ${chars}`);

  console.log('4. Озвучка по фразам, предпросмотр, подтверждение ещё не нажато');
  pushCb(ttsData);
  const v1 = await waitFor((c) => c.method === 'sendVoice', 'озвучка на проверку', 90000);
  const okData = v1.raw.match(/"callback_data":"(ok:[^"]+)"/)?.[1];
  const newData = v1.raw.match(/"callback_data":"(ttsnew:[^"]+)"/)?.[1];
  check(elCalls.length === 8, `к ElevenLabs ушло 8 запросов (по фразе): ${elCalls.length}`);
  check(elCalls.every((c) => c.key === 'testkey' && c.url.includes('/text-to-speech/voice123')), 'ключ и голос переданы верно');
  check(elCalls.some((c) => /пэ-дэ-дэ/.test(c.body.text)) && !elCalls.some((c) => /ПДД|\[[gry]\]/.test(c.body.text)), 'словарь произношения применён, разметка субтитров убрана');
  check(!!okData && !!newData, 'кнопки «Всё хорошо» и «Другой дубль» есть');
  await waitFor(has('sendMessage', 'ElevenLabs: использовано'), 'остаток символов');
  check(true, 'бот показал остаток символов в ElevenLabs');
  await sleep(2000);
  check(count('sendVideo') === 0 && !calls.some(has('sendMessage', 'Начинаю рендер')), 'рендер НЕ стартовал без подтверждения');

  console.log('5. Повторная озвучка берётся из кэша (символы не тратятся)');
  const before = elCalls.length;
  pushCb(ttsData);
  await waitFor(() => count('sendVoice') === 2, 'вторая озвучка', 60000);
  check(elCalls.length === before, 'новых запросов к ElevenLabs нет');
  check(calls.some(has('editMessageText', 'взято из кэша')), 'бот сообщил, что символы не тратились');

  console.log('6. «Другой дубль» обходит кэш');
  pushCb(newData);
  await waitFor(() => count('sendVoice') === 3, 'третья озвучка', 90000);
  check(elCalls.length === before + 8, `новый дубль: ещё 8 запросов (${elCalls.length - before})`);

  console.log('7. Подтверждение → рендер стартует');
  pushCb(okData);
  await waitFor((c) => c.method === 'sendMessage' && (c.raw.includes('Начинаю рендер') || c.raw.includes('В очереди')), 'старт рендера');
  check(true, 'после «Всё хорошо» пошёл рендер');
} catch (e) {
  console.error('\nОШИБКА:', e.message);
  failed = true;
} finally {
  bot.kill('SIGKILL');
  server.close();
  el.close();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(failed ? '\nТЕСТ НЕ ПРОЙДЕН' : '\nТЕСТ ПРОЙДЕН');
process.exit(failed ? 1 : 0);
