// Telegram-бот для создания роликов: сценарий (JSON) → запись голоса → видео.
// Запуск: BOT_TOKEN=... ALLOWED_IDS=123456 node src/bot/bot.mjs
import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy';
import fs from 'node:fs';
import path from 'node:path';
import { jobDir, getJob, recentJobs, updateJob, createJob } from './store.mjs';
import { parseScenarioText, describeScenario, VOICE_INSTRUCTION, prepareVoice, enqueueRender, queueLength, esc } from './pipeline.mjs';
import { AudioSplitError } from '../lib/audio.mjs';

const token = process.env.BOT_TOKEN;
if (!token) { console.error('Задайте BOT_TOKEN (токен от @BotFather)'); process.exit(1); }
const allowed = new Set((process.env.ALLOWED_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
if (!allowed.size) { console.error('Задайте ALLOWED_IDS — ваш Telegram ID (узнать: @userinfobot)'); process.exit(1); }
const QUALITY = process.env.RENDER_QUALITY ?? 'hd';

const bot = new Bot(token);
const state = new Map();   // chatId → { mode: 'scenario' | 'voice', jobId }

const menu = new Keyboard().text('🎬 Создать видео').text('📋 Мои ролики').resized();
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
bot.hears('📋 Мои ролики', async (ctx) => {
  const jobs = recentJobs(ctx.chat.id);
  if (!jobs.length) return ctx.reply('Пока ничего нет.');
  const label = { new: '🆕 ждёт голос', queued: '⏳ в очереди', rendering: '⚙️ рендерится', done: '✅ готов', failed: '⚠️ ошибка', interrupted: '⚠️ прервано' };
  const kb = new InlineKeyboard();
  jobs.forEach((j) => kb.text(`${label[j.status] ?? j.status} · ${j.title.slice(0, 28)}`, `open:${j.id}`).row());
  return ctx.reply('Последние ролики:', { reply_markup: kb });
});

async function showJob(ctx, job) {
  const kb = new InlineKeyboard();
  if (job.status === 'done' && job.video && fs.existsSync(job.video)) {
    await ctx.replyWithVideo(new InputFile(job.video), { caption: job.title, supports_streaming: true });
    kb.text('🎙 Перезаписать озвучку', `voice:${job.id}`).row().text('🖥 Full HD (1080p)', `render:${job.id}:fhd`);
  } else {
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
  if (withVoice && !job.voice) return ctx.reply('Сначала запишите озвучку.');
  const ahead = queueLength();
  let progressMsg = await ctx.reply(ahead ? `⏳ В очереди: перед вами ${ahead}.` : '⚙️ Начинаю рендер…');
  let lastEdit = 0;
  enqueueRender(jobId, {
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
  });
}

async function download(ctx, fileId, dest) {
  const f = await ctx.api.getFile(fileId).catch((e) => {
    throw new Error(/too big/i.test(e.message) ? 'Файл больше 20 МБ, Telegram не даёт боту его скачать. Отправьте запись как «Видео» (не как «Файл»): так Telegram её сожмёт.' : e.message);
  });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
  if (!res.ok) throw new Error(`Telegram не отдал файл (${res.status})`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function acceptScenario(ctx, text) {
  const { scenario, errors } = parseScenarioText(text);
  if (errors) return ctx.reply('⚠️ Со сценарием проблема:\n• ' + errors.slice(0, 8).join('\n• ') + '\n\nИсправьте и пришлите ещё раз.');
  const job = createJob(scenario, ctx.chat.id);
  state.set(ctx.chat.id, { mode: 'voice', jobId: job.id });
  const kb = new InlineKeyboard().text('🧪 Черновик без голоса', `draft:${job.id}`).text('❌ Отмена', 'cancel');
  await ctx.reply(describeScenario(scenario), HTML);
  await ctx.reply(VOICE_INSTRUCTION, { ...HTML, reply_markup: kb });
}

async function acceptVoice(ctx, fileId, ext) {
  const st = state.get(ctx.chat.id);
  if (st?.mode !== 'voice') return ctx.reply('Сначала нажмите «🎬 Создать видео» и пришлите сценарий (или выберите ролик в «📋 Мои ролики»).');
  const msg = await ctx.reply('🎧 Обрабатываю голос: убираю шум, режу на фразы…');
  try {
    const raw = path.join(jobDir(st.jobId), `raw${ext}`);
    await download(ctx, fileId, raw);
    const r = await prepareVoice(st.jobId, raw);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `✅ Голос принят: ${r.durations.length} фраз.`);
    // очищенный голос присылаем отдельно: можно сразу проверить звук до рендера
    await ctx.replyWithVoice(new InputFile(r.preview), { caption: 'Так звучит очищенная запись' }).catch(() => {});
    await startRender(ctx, st.jobId, QUALITY, true);
    state.delete(ctx.chat.id);
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
bot.start({ onStart: (me) => console.log(`Бот @${me.username} запущен, разрешено ID: ${[...allowed].join(', ')}`) }).catch((e) => {
  console.error(e.error_code === 401 ? 'Неверный BOT_TOKEN: возьмите новый у @BotFather' : `Не удалось запустить бота: ${e.message}`);
  process.exit(1);
});
