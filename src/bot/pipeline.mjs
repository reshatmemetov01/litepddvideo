// Логика создания ролика без привязки к Telegram: разбор сценария, голос, очередь рендера.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateScenario } from '../lib/validate.mjs';
import { renderScenario } from '../lib/render.mjs';
import { processRecording } from '../lib/audio.mjs';
import { estimateDuration, layoutPhrases } from '../lib/timeline.mjs';
import { jobDir, readScenario, updateJob, getJob } from './store.mjs';

const strip = (t) => t.replace(/\[\/?[gry]\]/g, '');
export const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Текст сообщения или файла → сценарий. Понимает JSON в ```-блоках. */
export function parseScenarioText(text) {
  const clean = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  let scenario;
  try { scenario = JSON.parse(clean); }
  catch (e) { return { errors: [`Это не JSON: ${e.message}`] }; }
  const errors = validateScenario(scenario);
  return errors.length ? { errors } : { scenario };
}

export function describeScenario(s) {
  const { total } = layoutPhrases(s.voiceover.map((v) => estimateDuration(v.text)));
  const phrases = s.voiceover.map((v, i) => `<b>${i + 1}.</b> ${esc(strip(v.text))}`).join('\n');
  const answer = s.card ? `\nОтвет: <b>${s.card.correct + 1}${s.card.answers ? '. ' + esc(s.card.answers[s.card.correct]) : ''}</b>` : '';
  return `🎬 <b>${esc(s.title ?? 'Сценарий')}</b>${answer}\n\n` +
    `Фразы для озвучки (${s.voiceover.length}):\n${phrases}\n\n` +
    `Примерная длина ролика: ~${Math.round(total)} с`;
}

export const VOICE_INSTRUCTION =
  '🎙 Запишите голосовое сообщение: прочитайте фразы <b>по порядку</b>, между фразами делайте паузу <b>1–2 секунды</b> (молча). ' +
  'Если оговорились — просто перепишите запись целиком. Шум и эхо я уберу.';

/** Запись голоса → очищенная дорожка и длительности фраз. */
export async function prepareVoice(jobId, rawPath) {
  const s = readScenario(jobId);
  const dir = path.join(jobDir(jobId), 'voice');
  let r;
  try { r = await processRecording(rawPath, s.voiceover.length, dir); }
  finally { fs.rmSync(rawPath, { force: true }); }   // сырая запись больше не нужна
  fs.rmSync(r.cleaned, { force: true });             // промежуточный файл тоже
  // ogg/opus — чтобы бот мог прислать очищенный голос на проверку
  const preview = path.join(dir, 'voice.ogg');
  await new Promise((res, rej) => spawn('ffmpeg', ['-y', '-v', 'error', '-i', r.track, '-c:a', 'libopus', '-b:a', '48k', preview]).on('close', (c) => (c ? rej(new Error('ffmpeg opus')) : res())));
  updateJob(jobId, { voice: { track: r.track, durations: r.durations } });
  return { ...r, preview };
}

// ---- очередь: рендер по одному ролику, чтобы хватало 4 ГБ памяти ----
const queue = [];
let busy = false;
export const queueLength = () => queue.length + (busy ? 1 : 0);

const MAX_QUEUE = +process.env.MAX_QUEUE || 5;

export function enqueueRender(jobId, { quality, withVoice, onStart, onProgress, onDone, onError }) {
  if (queueLength() >= MAX_QUEUE) throw new Error(`Очередь заполнена (${MAX_QUEUE}), подождите, пока освободится`);
  updateJob(jobId, { status: 'queued', quality });
  queue.push({ jobId, quality, withVoice, onStart, onProgress, onDone, onError });
  pump();
  return queue.length;
}

async function pump() {
  if (busy) return;
  const task = queue.shift();
  if (!task) return;
  busy = true;
  const { jobId, quality, withVoice } = task;
  try {
    updateJob(jobId, { status: 'rendering' });
    await task.onStart?.();
    const job = getJob(jobId);
    const out = path.join(jobDir(jobId), `${quality}${withVoice ? '' : '-draft'}.mp4`);
    const res = await renderScenario({
      scenario: readScenario(jobId),
      durations: withVoice ? job.voice.durations : undefined,
      audio: withVoice ? job.voice.track : undefined,
      quality, out,
      onProgress: task.onProgress,
    });
    updateJob(jobId, { status: 'done', video: out, withVoice });
    await task.onDone?.(res.out, res);
  } catch (e) {
    updateJob(jobId, { status: 'failed', error: String(e.message).slice(0, 500) });
    await task.onError?.(e);
  } finally {
    busy = false;
    pump();
  }
}
