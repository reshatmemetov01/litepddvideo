// Telegram-бот для создания роликов: сценарий (JSON) → запись голоса → видео.
// Запуск: BOT_TOKEN=... ALLOWED_IDS=123456 node src/bot/bot.mjs
import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy';
import fs from 'node:fs';
import path from 'node:path';
import { jobDir, getJob, recentJobs, updateJob, createJob, dataDir } from './store.mjs';
import { parseScenarioText, describeScenario, VOICE_INSTRUCTION, prepareVoice, prepareTts, ttsChars, cloneFromRecording, CLONE_GOOD_SECONDS, enqueueRender, queueLength, esc } from './pipeline.mjs';
import { ttsConfigured, ttsKeySet, getUsage, savedVoice, currentVoiceId } from '../lib/tts.mjs';
import { AudioSplitError } from '../lib/audio.mjs';
import { layoutPhrases } from '../lib/timeline.mjs';
import { ensureSpace, startCleanupTimer, freeGB, dirSizeMB, MIN_FREE_GB, RETENTION_DAYS } from './cleanup.mjs';
import { root } from '../lib/render.mjs';
import os from 'node:os';

const token = process.env.BOT_TOKEN;
if (!token) { console.error('Задайте BOT_TOKEN (токен от @BotFather)'); process.exit(1); }
const allowed = new Set((process.env.ALLOWED_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
if (!allowed.size) { console.error('Задайте ALLOWED_IDS — ваш Telegram ID (узнать: @userinfobot)'); process.exit(1); }
const QUALITY = process.env.RENDER_QUALITY ?? 'hd';

const API_ROOT = process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';   // свой адрес нужен только для тестов
const bot = new Bot(token, { client: { apiRoot: API_ROOT } });
const state = new Map();   // chatId → { mode: 'scenario' | 'voice', jobId }

const menu = new Keyboard().text('🎬 Создать видео').text('📋 Мои ролики').row().text('🧬 Клонировать голос').resized();
const HTML = { parse_mode: 'HTML' };

bot.use(async (ctx, next) => {
  if (!allowed.has(ctx.from?.id)) { if (ctx.chat?.type === 'private') await ctx.reply('Бот закрытый.'); return; }
  await next();
});

bot.command('start', (ctx) => ctx.reply('Привет! Я собираю ролики с разбором ПДД.\nНажмите «🎬 Создать видео» и пришлите сценарий.', { reply_markup: menu }));
bot.hears('🎬 Создать видео', (ctx) => {
  state.set(ctx.chat.id, { mode: 'scenario' });
  return ctx.reply('Пришлите сценарий: текстом сообщения или файлом .json.');
});
// ---- клонирование голоса ----
const CLONE_INSTRUCTION =
  '🧬 Пришлите запись вашего голоса: mp3 (или другой аудиофайл, голосовое, видео).\n\n' +
  '• <b>1–2 минуты</b> связной речи (минимум 10 секунд, но клон будет хуже)\n' +
  '• тихая комната, только ваш голос, без музыки\n' +
  '• говорите так, как хотите звучать в роликах: бодро, с интонацией\n' +
  '• запись <b>не обрабатывайте</b>: шумодав и эффекты клон тоже скопирует';
async function startClone(ctx) {
  if (!ttsKeySet()) return ctx.reply('Не задан ключ ElevenLabs: впишите ELEVENLABS_API_KEY в .env на сервере и перезапустите бота.');
  state.set(ctx.chat.id, { mode: 'clone' });
  const cur = savedVoice(dataDir);
  const note = cur ? `\n\nСейчас используется клон от ${new Date(cur.createdAt).toLocaleDateString('ru-RU')}. Новый клон заменит его в боте.` : '';
  await ctx.reply(CLONE_INSTRUCTION + note, { ...HTML, reply_markup: new InlineKeyboard().text('❌ Отмена', 'cancel') });
}
bot.command('clone', startClone);
bot.hears('🧬 Клонировать голос', startClone);
bot.command('voice', (ctx) => {
  const cur = savedVoice(dataDir), id = currentVoiceId(dataDir);
  if (!ttsKeySet()) return ctx.reply('Озвучка через ElevenLabs не настроена: нет ELEVENLABS_API_KEY в .env.');
  if (!id) return ctx.reply('Голос ещё не склонирован. Команда /clone.');
  return ctx.reply(cur ? `🗣 Голос: клон от ${new Date(cur.createdAt).toLocaleString('ru-RU')}\nID: ${id}` : `🗣 Голос из .env (ELEVENLABS_VOICE_ID)\nID: ${id}`);
});

async function acceptClone(ctx, fileId, ext) {
  const msg = await ctx.reply('🧬 Загружаю запись в ElevenLabs и создаю клон…');
  try {
    const raw = path.join(dataDir, 'clone', `raw${ext}`);
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    await download(ctx, fileId, raw);
    const r = await cloneFromRecording(raw);
    state.delete(ctx.chat.id);
    const short = r.seconds < CLONE_GOOD_SECONDS ? `\n⚠️ Запись ${Math.round(r.seconds)} с: для лучшего сходства лучше 1–2 минуты. Можно переклонировать позже.` : '';
    const old = r.previous ? `\nСтарый клон остался в вашем аккаунте ElevenLabs: если голосов-слотов не хватает, удалите его там вручную.` : '';
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✅ Голос склонирован и подключён (ID ${r.voiceId}).${short}${old}\n\nТеперь после загрузки сценария будет кнопка «🤖 Озвучить моим голосом».`);
    if (r.preview?.error) await ctx.reply(`Пробная фраза не озвучилась: ${r.preview.error}`);
    else if (r.preview) await ctx.replyWithVoice(new InputFile(r.preview), { caption: 'Пробная фраза новым голосом' });
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `⚠️ ${e.message.slice(0, 600)}\n\nМожно прислать другую запись или нажать /clone заново.`);
  }
}

bot.command('disk', (ctx) => {
  const free = freeGB(), data = dirSizeMB(path.join(root, 'data'));
  return ctx.reply(`💾 Свободно на диске: ${free.toFixed(1)} ГБ\n📁 Данные бота: ${data.toFixed(0)} МБ\n🧠 Память: свободно ${(os.freemem() / 2 ** 30).toFixed(1)} из ${(os.totalmem() / 2 ** 30).toFixed(1)} ГБ\n🗑 Ролики хранятся ${RETENTION_DAYS} дн., потом удаляются сами`);
});
bot.hears('📋 Мои ролики', async (ctx) => {
  const jobs = recentJobs(ctx.chat.id);
  if (!jobs.length) return ctx.reply('Пока ничего нет.');
  const label = { new: '🆕 ждёт голос', voice_ready: '🎧 ждёт подтверждения', queued: '⏳ в очереди', rendering: '⚙️ рендерится', done: '✅ готов', failed: '⚠️ ошибка', interrupted: '⚠️ прервано' };
  const kb = new InlineKeyboard();
  jobs.forEach((j) => kb.text(`${label[j.status] ?? j.status} · ${j.title.slice(0, 28)}`, `open:${j.id}`).row());
  return ctx.reply('Последние ролики:', { reply_markup: kb });
});

async function showJob(ctx, job) {
  const kb = new InlineKeyboard();
  if (job.status === 'voice_ready' && job.voice) {
    kb.text('✅ Всё хорошо, делать видео', `ok:${job.id}`).row().text('🎙 Перезаписать', `voice:${job.id}`);
  } else if (job.status === 'done' && job.video && fs.existsSync(job.video)) {
    await ctx.replyWithVideo(new InputFile(job.video), { caption: job.title, supports_streaming: true });
    kb.text('🎙 Перезаписать озвучку', `voice:${job.id}`).row().text('🖥 Full HD (1080p)', `render:${job.id}:fhd`);
  } else {
    if (ttsConfigured(dataDir)) kb.text('🤖 Озвучить моим голосом', `tts:${job.id}`).row();
    kb.text('🎙 Записать озвучку', `voice:${job.id}`).row().text('🧪 Черновик без голоса', `draft:${job.id}`);
    if (job.status === 'failed' || job.status === 'interrupted') kb.row().text('🔁 Повторить', `render:${job.id}:${QUALITY}`);
  }
  await ctx.reply(job.status === 'failed' ? `⚠️ ${esc(job.error ?? 'ошибка')}` : 'Что делаем дальше?', { ...HTML, reply_markup: kb });
}

bot.callbackQuery(/^open:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const j = getJob(ctx.match[1]); if (j) await showJob(ctx, j); });
bot.callbackQuery(/^voice:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  state.set(ctx.chat.id, { mode: 'voice', jobId: ctx.match[1] });
  await ctx.reply(VOICE_INSTRUCTION, HTML);
});
async function runTts(ctx, jobId, fresh) {
  const job = getJob(jobId);
  if (!job) return ctx.reply('Не нашёл этот ролик.');
  if (['queued', 'rendering'].includes(job.status)) return ctx.reply('Этот ролик уже в очереди или рендерится.');
  const msg = await ctx.reply('🤖 Озвучиваю вашим голосом…');
  try {
    const r = await prepareTts(jobId, { fresh });
    const { total } = layoutPhrases(r.durations);
    const spent = r.chars ? `списано ${r.chars} симв.` : 'взято из кэша, символы не тратились';
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✅ Озвучено: ${r.durations.length} фраз, ролик ~${Math.round(total)} с (${spent}${r.fromCache && r.chars ? `, ${r.fromCache} фраз из кэша` : ''}).`);
    const kb = new InlineKeyboard().text('✅ Всё хорошо, делать видео', `ok:${jobId}`).row()
      .text('🔁 Другой дубль (спишет символы)', `ttsnew:${jobId}`).row().text('🎙 Записать самому', `voice:${jobId}`);
    await ctx.replyWithVoice(new InputFile(r.preview), { caption: 'Так прозвучит озвучка в ролике. Всё устраивает?', reply_markup: kb });
    state.set(ctx.chat.id, { mode: 'voice', jobId });
    const usage = await getUsage();
    if (usage) await ctx.reply(`ℹ️ ElevenLabs: использовано ${usage.used} из ${usage.limit} символов в этом периоде.`);
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `⚠️ ${e.message.slice(0, 500)}`);
  }
}
bot.callbackQuery(/^tts:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await runTts(ctx, ctx.match[1], false); });
bot.callbackQuery(/^ttsnew:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await runTts(ctx, ctx.match[1], true); });
bot.callbackQuery(/^ok:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const job = getJob(ctx.match[1]);
  if (!job?.voice) return ctx.reply('Сначала запишите озвучку.');
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});   // убираем кнопки, чтобы не нажать дважды
  state.delete(ctx.chat.id);
  await startRender(ctx, job.id, QUALITY, true);
});
bot.callbackQuery(/^draft:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await startRender(ctx, ctx.match[1], 'draft', false); });
bot.callbackQuery(/^render:(.+):(hd|fhd)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const job = getJob(ctx.match[1]);
  await startRender(ctx, ctx.match[1], ctx.match[2], !!job?.voice);
});
bot.callbackQuery('cancel', async (ctx) => { await ctx.answerCallbackQuery(); state.delete(ctx.chat.id); await ctx.reply('Отменено.'); });

async function startRender(ctx, jobId, quality, withVoice) {
  const job = getJob(jobId);
  if (!job) return ctx.reply('Не нашёл этот ролик.');
  if (['queued', 'rendering'].includes(job.status)) return ctx.reply('Этот ролик уже в очереди или рендерится.');
  if (withVoice && !job.voice) return ctx.reply('Сначала запишите озвучку.');
  const free = ensureSpace();
  if (free < 1) return ctx.reply(`⚠️ На сервере почти нет места (свободно ${free.toFixed(1)} ГБ). Освободите диск и повторите.`);
  const ahead = queueLength();
  let progressMsg = await ctx.reply(ahead ? `⏳ В очереди: перед вами ${ahead}.` : '⚙️ Начинаю рендер…');
  let lastEdit = 0;
  try { enqueueRender(jobId, {
    quality, withVoice,
    onStart: () => ctx.api.editMessageText(ctx.chat.id, progressMsg.message_id, '⚙️ Рендерю видео…').catch(() => {}),
    onProgress: ({ frame, total, seconds }) => {
      if (Date.now() - lastEdit < 15000) return;
      lastEdit = Date.now();
      const left = Math.max(0, Math.round((seconds / frame) * (total - frame) / 60));
      ctx.api.editMessageText(ctx.chat.id, progressMsg.message_id, `⚙️ Рендерю: ${Math.round((frame / total) * 100)}% · осталось ~${left || '<1'} мин`).catch(() => {});
    },
    onDone: async (out, res) => {
      await ctx.api.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
      const kb = new InlineKeyboard().text('🎙 Перезаписать озвучку', `voice:${jobId}`);
      if (quality !== 'fhd') kb.row().text('🖥 Full HD (1080p)', `render:${jobId}:fhd`);
      await ctx.api.sendVideo(ctx.chat.id, new InputFile(out), {
        caption: `${job.title}${withVoice ? '' : '\n(черновик, без голоса)'}`, supports_streaming: true, reply_markup: kb,
      });
    },
    onError: (e) => ctx.api.editMessageText(ctx.chat.id, progressMsg.message_id, `⚠️ Рендер не удался: ${e.message.slice(0, 600)}`).catch(() => {}),
  }); } catch (e) { await ctx.api.editMessageText(ctx.chat.id, progressMsg.message_id, `⚠️ ${e.message}`).catch(() => {}); }
}

async function download(ctx, fileId, dest) {
  const f = await ctx.api.getFile(fileId).catch((e) => {
    throw new Error(/too big/i.test(e.message) ? 'Файл больше 20 МБ, Telegram не даёт боту его скачать. Отправьте запись как «Видео» (не как «Файл»): так Telegram её сожмёт.' : e.message);
  });
  const res = await fetch(`${API_ROOT}/file/bot${token}/${f.file_path}`);
  if (!res.ok) throw new Error(`Telegram не отдал файл (${res.status})`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function acceptScenario(ctx, text) {
  const { scenario, errors } = parseScenarioText(text);
  if (errors) return ctx.reply('⚠️ Со сценарием проблема:\n• ' + errors.slice(0, 8).join('\n• ') + '\n\nИсправьте и пришлите ещё раз.');
  const job = createJob(scenario, ctx.chat.id);
  state.set(ctx.chat.id, { mode: 'voice', jobId: job.id });
  const kb = new InlineKeyboard();
  if (ttsConfigured(dataDir)) kb.text(`🤖 Озвучить моим голосом (${ttsChars(job.id)} симв.)`, `tts:${job.id}`).row();
  kb.text('🧪 Черновик без голоса', `draft:${job.id}`).text('❌ Отмена', 'cancel');
  await ctx.reply(describeScenario(scenario), HTML);
  await ctx.reply(VOICE_INSTRUCTION, { ...HTML, reply_markup: kb });
}

async function acceptVoice(ctx, fileId, ext) {
  const st = state.get(ctx.chat.id);
  if (st?.mode === 'clone') return acceptClone(ctx, fileId, ext);
  if (st?.mode !== 'voice') return ctx.reply('Сначала нажмите «🎬 Создать видео» и пришлите сценарий (или выберите ролик в «📋 Мои ролики»).');
  const msg = await ctx.reply('🎧 Обрабатываю голос: убираю шум, режу на фразы…');
  try {
    const raw = path.join(jobDir(st.jobId), `raw${ext}`);
    await download(ctx, fileId, raw);
    const r = await prepareVoice(st.jobId, raw);
    const { total } = layoutPhrases(r.durations);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✅ Голос обработан: ${r.durations.length} фраз, ролик получится ~${Math.round(total)} с.`);
    // рендер НЕ запускаем: сначала вы слушаете очищенную запись и подтверждаете или перезаписываете
    const kb = new InlineKeyboard().text('✅ Всё хорошо, делать видео', `ok:${st.jobId}`).row().text('🎙 Перезаписать', `voice:${st.jobId}`);
    if (ttsConfigured(dataDir)) kb.row().text('🤖 Озвучить моим голосом', `tts:${st.jobId}`);
    await ctx.replyWithVoice(new InputFile(r.preview), { caption: 'Так прозвучит озвучка в ролике. Всё устраивает? Можно и просто прислать новую запись: она заменит эту.', reply_markup: kb });
    state.set(ctx.chat.id, { mode: 'voice', jobId: st.jobId });
  } catch (e) {
    const text = e instanceof AudioSplitError
      ? `⚠️ ${e.message}. Читайте фразы по порядку, между ними — пауза 1–2 секунды молча. Запишите ещё раз.`
      : `⚠️ Не получилось обработать запись: ${e.message.slice(0, 400)}`;
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, text);
  }
}

bot.on(['message:voice', 'message:audio'], (ctx) => {
  const f = ctx.message.voice ?? ctx.message.audio;
  return acceptVoice(ctx, f.file_id, ctx.message.voice ? '.ogg' : path.extname(f.file_name ?? '') || '.m4a');
});
// запись экрана с голосом: звук берётся из видео (картинка игнорируется)
bot.on(['message:video', 'message:video_note'], (ctx) => {
  const f = ctx.message.video ?? ctx.message.video_note;
  return acceptVoice(ctx, f.file_id, path.extname(f.file_name ?? '') || '.mp4');
});
bot.on('message:document', async (ctx) => {
  const d = ctx.message.document, st = state.get(ctx.chat.id);
  if (d.file_name?.endsWith('.json')) {
    const tmp = path.join(jobDir('_tmp'), 'in.json');
    await download(ctx, d.file_id, tmp);
    return acceptScenario(ctx, fs.readFileSync(tmp, 'utf8'));
  }
  if (d.mime_type?.startsWith('audio/') || d.mime_type?.startsWith('video/') || /\.(m4a|mp3|wav|ogg|aac|mp4|mov|mkv|webm)$/i.test(d.file_name ?? '')) return acceptVoice(ctx, d.file_id, path.extname(d.file_name) || '.m4a');
  return ctx.reply('Пришлите .json со сценарием, а для озвучки аудио или видеозапись экрана с голосом.');
});
bot.on('message:text', (ctx) => {
  const st = state.get(ctx.chat.id);
  if (st?.mode === 'scenario' || ctx.message.text.trim().startsWith('{') || ctx.message.text.trim().startsWith('```')) return acceptScenario(ctx, ctx.message.text);
  return ctx.reply('Нажмите «🎬 Создать видео».', { reply_markup: menu });
});

bot.catch((e) => console.error('[bot]', e.error?.message ?? e));
startCleanupTimer();
bot.start({ onStart: (me) => console.log(`Бот @${me.username} запущен, разрешено ID: ${[...allowed].join(', ')}`) }).catch((e) => {
  console.error(e.error_code === 401 ? 'Неверный BOT_TOKEN: возьмите новый у @BotFather' : `Не удалось запустить бота: ${e.message}`);
  process.exit(1);
});
