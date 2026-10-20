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
const longRec = path.join(work, 'long.mp3'), shortRec = path.join(work, 'short.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=180:d=70', '-c:a', 'libmp3lame', longRec]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=180:d=5', '-c:a', 'libmp3lame', shortRec]);
const files = { doc1: path.join(root, 'ready', 'q13_levo_svetofor.json'), long1: longRec, short1: shortRec };
const calls = [];
const elCalls = [];
const el = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url.startsWith('/v1/user/subscription')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ character_count: 1234, character_limit: 30000 })); }
    const vm = req.method === 'GET' && req.url.match(/^\/v1\/voices\/([A-Za-z0-9]+)$/);
    if (vm) {
      elCalls.push({ url: req.url, key: req.headers['xi-api-key'], method: 'GET' });
      res.setHeader('Content-Type', 'application/json');
      if (vm[1] === 'LIBVOICE000001') return res.end(JSON.stringify({ voice_id: 'LIBVOICE000001', name: 'Adam', category: 'premade' }));
      res.statusCode = 404; return res.end('{"detail":{"status":"voice_not_found","message":"A voice with the voice_id was not found."}}');
    }
    if (req.url.startsWith('/v1/voices/add')) {
      const raw = Buffer.concat(chunks);
      elCalls.push({ url: req.url, key: req.headers['xi-api-key'], multipart: /multipart\/form-data/.test(req.headers['content-type']), size: raw.length, hasName: raw.toString('latin1').includes('name="name"') });
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ voice_id: 'CLONED1' }));
    }
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
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true,   // своя группа процессов: при завершении гасим и Chromium/ffmpeg рендера
  env: { ...process.env, BOT_TOKEN: TOKEN, ALLOWED_IDS: '1', TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`, ELEVENLABS_API_KEY: 'testkey', ELEVENLABS_API_ROOT: `http://127.0.0.1:${el.address().port}`, DATA_DIR: path.join(work, 'data'), RENDER_QUALITY: 'draft', RENDER_WORKERS: '3' },
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

  check(!calls.some(has('sendMessage', 'Озвучить:')), 'пока голос не склонирован, кнопки озвучки нет');

  console.log('3. /clone: короткая запись отклоняется, нормальная клонируется');
  pushMsg({ text: '🧬 Клонировать голос' });
  await waitFor(has('sendMessage', 'Пришлите запись вашего голоса'), 'инструкция по записи');
  pushMsg({ audio: { file_id: 'short1', duration: 5, mime_type: 'audio/mpeg', file_name: 'short.mp3' } });
  await waitFor(has('editMessageText', 'слишком короткая'), 'отказ на короткой записи');
  check(!elCalls.some((c) => c.url.startsWith('/v1/voices/add')), 'короткая запись не ушла в ElevenLabs');
  pushMsg({ audio: { file_id: 'long1', duration: 70, mime_type: 'audio/mpeg', file_name: 'my_voice.mp3' } });
  await waitFor(has('editMessageText', 'Голос склонирован'), 'клон создан', 60000);
  const add = elCalls.find((c) => c.url.startsWith('/v1/voices/add'));
  check(add?.multipart && add.key === 'testkey' && add.hasName && add.size > 100000, 'запись ушла в ElevenLabs (multipart, ключ, имя)');
  await waitFor((c) => c.method === 'sendVoice' && c.raw.includes('Пробная фраза'), 'пробная фраза новым голосом', 30000);
  check(elCalls.some((c) => c.url.includes('/text-to-speech/CLONED1')), 'пробная фраза озвучена новым голосом');
  check(JSON.parse(fs.readFileSync(path.join(work, 'data', 'voices.json'), 'utf8')).active === 'CLONED1', 'ID клона сохранён ботом и выбран активным');
  check(!fs.existsSync(path.join(work, 'data', 'clone', 'raw.mp3')), 'исходная запись удалена после клонирования');
  pushMsg({ text: '/voice', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await waitFor(has('sendMessage', 'CLONED1'), '/voice показывает голос');
  check(true, '/voice показывает текущий клон');

  console.log('3b. Новый сценарий: появилась кнопка «Озвучить: <голос>»');
  pushMsg({ text: '🎬 Создать видео' });
  await sleep(500);
  pushMsg({ document: { file_id: 'doc1', file_name: 'q13.json', mime_type: 'application/json' } });
  const scen = await waitFor(has('sendMessage', 'Озвучить: Голос для роликов'), 'кнопка озвучки с именем клона');
  const ttsData = scen.raw.match(/"callback_data":"(tts:[^"]+)"/)?.[1];
  check(!!ttsData && /симв\./.test(scen.raw), `кнопка есть (${ttsData})`);
  const chars = +scen.raw.match(/\((\d+) симв\./)[1];
  check(chars > 300 && chars < 450, `число символов разумное: ${chars}`);
  const tts = () => elCalls.filter((c) => c.url.includes('/text-to-speech/') && !/Пробная|Проверяем/.test(c.body?.text ?? ''));
  const voices = () => count('sendVoice');
  const v0 = voices();

  console.log('4. Озвучка по фразам, предпросмотр, подтверждение ещё не нажато');
  pushCb(ttsData);
  await waitFor(() => voices() === v0 + 1, 'озвучка на проверку', 90000);
  const v1 = calls.filter((c) => c.method === 'sendVoice').at(-1);
  const okData = v1.raw.match(/"callback_data":"(ok:[^"]+)"/)?.[1];
  const newData = v1.raw.match(/"callback_data":"(ttsnew:[^"]+)"/)?.[1];
  check(tts().length === 8, `к ElevenLabs ушло 8 запросов (по фразе): ${tts().length}`);
  check(tts().every((c) => c.key === 'testkey' && c.url.includes('/text-to-speech/CLONED1')), 'озвучка идёт клонированным голосом');
  check(tts().some((c) => /пэ-дэ-дэ/.test(c.body.text)) && !tts().some((c) => /ПДД|\[[gry]\]/.test(c.body.text)), 'словарь произношения применён, разметка субтитров убрана');
  check(!!okData && !!newData, 'кнопки «Всё хорошо» и «Другой дубль» есть');
  await waitFor(has('sendMessage', 'ElevenLabs: использовано'), 'остаток символов');
  check(true, 'бот показал остаток символов в ElevenLabs');
  await sleep(2000);
  check(count('sendVideo') === 0 && !calls.some(has('sendMessage', 'Начинаю рендер')), 'рендер НЕ стартовал без подтверждения');

  console.log('5. Повторная озвучка берётся из кэша (символы не тратятся)');
  const before = tts().length;
  pushCb(ttsData);
  await waitFor(() => voices() === v0 + 2, 'вторая озвучка', 60000);
  check(tts().length === before, 'новых запросов к ElevenLabs нет');
  check(calls.some(has('editMessageText', 'взято из кэша')), 'бот сообщил, что символы не тратились');

  console.log('6. «Другой дубль» обходит кэш');
  pushCb(newData);
  await waitFor(() => voices() === v0 + 3, 'третья озвучка', 90000);
  check(tts().length === before + 8, `новый дубль: ещё 8 запросов (${tts().length - before})`);

  console.log('7. Подтверждение → рендер стартует');
  pushCb(okData);
  await waitFor((c) => c.method === 'sendMessage' && (c.raw.includes('Начинаю рендер') || c.raw.includes('В очереди')), 'старт рендера');
  check(true, 'после «Всё хорошо» пошёл рендер');

  console.log('8. Голоса ElevenLabs по ID');
  pushMsg({ text: '🗣 Голоса' });
  const list = await waitFor(has('sendMessage', 'Голоса для озвучки'), 'список голосов');
  check(list.raw.includes('CLONED1') && list.raw.includes('"callback_data":"vadd"'), 'в списке есть клон и кнопка добавления по ID');
  pushCb('vadd');
  await waitFor(has('sendMessage', 'Пришлите ID голоса'), 'просьба прислать ID');
  pushMsg({ text: 'привет' });
  await waitFor(has('editMessageText', 'Не похоже на ID'), 'отказ на мусоре');
  check(true, 'текст без ID отклонён');
  pushMsg({ text: 'BADVOICE000001' });
  await waitFor(has('editMessageText', 'недоступен вашему аккаунту'), 'отказ на чужом ID');
  check(true, 'неизвестный ID: понятная ошибка про «добавьте в мои голоса»');
  pushMsg({ text: 'https://elevenlabs.io/app/voice-library?voiceId=LIBVOICE000001' });
  await waitFor(has('editMessageText', 'Голос «Adam» добавлен'), 'голос добавлен по ссылке');
  await waitFor((c) => c.method === 'sendVoice' && c.raw.includes('Пробная фраза голосом «Adam»'), 'пробная фраза Adam', 30000);
  check(elCalls.some((c) => c.url.includes('/text-to-speech/LIBVOICE000001')), 'ID извлечён из ссылки, пробная фраза озвучена голосом Adam');

  console.log('9. Новый ролик озвучивается активным голосом (Adam)');
  pushMsg({ text: '🎬 Создать видео' });
  await sleep(500);
  const nCalls = calls.length;
  pushMsg({ document: { file_id: 'doc1', file_name: 'q13.json', mime_type: 'application/json' } });
  const scen2 = await waitFor((c) => calls.indexOf(c) >= nCalls && c.method === 'sendMessage' && c.raw.includes('Озвучить: Adam'), 'кнопка с именем голоса');
  const tts2 = scen2.raw.match(/"callback_data":"(tts:[^"]+)"/)[1];
  const ttsc2 = scen2.raw.match(/"callback_data":"(ttsc:[^"]+)"/)?.[1];
  check(!!ttsc2, 'есть кнопка «Озвучить другим голосом»');
  const adamBefore = elCalls.filter((c) => c.url.includes('/text-to-speech/LIBVOICE000001')).length;
  const vb = voices();
  pushCb(tts2);
  await waitFor(() => voices() === vb + 1, 'озвучка Adam', 90000);
  check(elCalls.filter((c) => c.url.includes('/text-to-speech/LIBVOICE000001')).length - adamBefore === 8, 'все 8 фраз озвучены голосом Adam');
  check(calls.some(has('editMessageText', 'голосом «Adam»')), 'бот пишет, каким голосом озвучено');

  console.log('10. Для одного ролика можно выбрать другой голос (клон), активный не меняется');
  pushCb(ttsc2);
  const pick = await waitFor(has('sendMessage', 'Каким голосом озвучить этот ролик'), 'выбор голоса');
  const toClone = pick.raw.match(/"callback_data":"(ttsv:[^"]+:CLONED1)"/)?.[1];
  check(!!toClone, 'в выборе есть клон');
  const cloneBefore = elCalls.filter((c) => c.url.includes('/text-to-speech/CLONED1')).length;
  pushCb(toClone);
  await waitFor(() => voices() === vb + 2, 'озвучка клоном', 90000);
  check(elCalls.filter((c) => c.url.includes('/text-to-speech/CLONED1')).length === cloneBefore, 'текст уже озвучивался клоном: взят из кэша, символы не потрачены');
  check(JSON.parse(fs.readFileSync(path.join(work, 'data', 'voices.json'), 'utf8')).active === 'LIBVOICE000001', 'активный голос остался Adam');

  console.log('11. Смена активного голоса и удаление из списка');
  pushCb('vsel:CLONED1');
  await waitFor((c) => c.method === 'answerCallbackQuery' && c.raw.includes('Голос выбран'), 'голос выбран');
  check(JSON.parse(fs.readFileSync(path.join(work, 'data', 'voices.json'), 'utf8')).active === 'CLONED1', 'активный теперь клон');
  pushCb('vdel:LIBVOICE000001');
  await waitFor((c) => c.method === 'answerCallbackQuery' && c.raw.includes('Убран из списка'), 'голос убран');
  const reg = JSON.parse(fs.readFileSync(path.join(work, 'data', 'voices.json'), 'utf8'));
  check(!reg.voices.some((v) => v.id === 'LIBVOICE000001') && reg.active === 'CLONED1', 'Adam убран из списка, клон остался активным');
} catch (e) {
  console.error('\nОШИБКА:', e.message);
  failed = true;
} finally {
  try { process.kill(-bot.pid, 'SIGKILL'); } catch { bot.kill('SIGKILL'); }
  await sleep(300);
  server.close();
  el.close();
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(failed ? '\nТЕСТ НЕ ПРОЙДЕН' : '\nТЕСТ ПРОЙДЕН');
process.exit(failed ? 1 : 0);
