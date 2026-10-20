// Логика создания ролика без привязки к Telegram: разбор сценария, голос, очередь рендера.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateScenario } from '../lib/validate.mjs';
import { renderScenario } from '../lib/render.mjs';
import { processRecording, assembleFromFiles, duration } from '../lib/audio.mjs';
import { synthesizePhrases, countChars, cloneVoice, parseVoiceId, fetchVoiceInfo, addVoice, currentVoiceId, voiceName } from '../lib/tts.mjs';
import { estimateDuration, layoutPhrases } from '../lib/timeline.mjs';
import { jobDir, readScenario, updateJob, getJob, dataDir } from './store.mjs';

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
  'Если оговорились — просто перепишите запись целиком. Шум и эхо я уберу, потом пришлю очищенный голос, и вы подтвердите его или запишете заново.';

/** Запись голоса → очищенная дорожка и длительности фраз. */
export async function prepareVoice(jobId, rawPath) {
  const s = readScenario(jobId);
  const dir = path.join(jobDir(jobId), 'voice');
  let r;
  try { r = await processRecording(rawPath, s.voiceover.length, dir); }
  finally { fs.rmSync(rawPath, { force: true }); }   // сырая запись больше не нужна
  fs.rmSync(r.cleaned, { force: true });             // промежуточный файл тоже
  const preview = await makePreview(r.track, dir);
  updateJob(jobId, { status: 'voice_ready', voice: { track: r.track, durations: r.durations, source: 'manual' } });
  return { ...r, preview };
}

// ogg/opus нужен, чтобы бот мог прислать озвучку на проверку как голосовое
async function makePreview(track, dir) {
  const preview = path.join(dir, 'voice.ogg');
  await new Promise((res, rej) => spawn('ffmpeg', ['-y', '-v', 'error', '-i', track, '-c:a', 'libopus', '-b:a', '48k', preview]).on('close', (c) => (c ? rej(new Error('ffmpeg opus')) : res())));
  return preview;
}

/** Озвучка текста сценария клонированным голосом. fresh: новый дубль без кэша (тратит символы заново). */
export async function prepareTts(jobId, { fresh = false, voiceId = currentVoiceId(dataDir) } = {}) {
  const s = readScenario(jobId);
  const dir = path.join(jobDir(jobId), 'voice');
  const r = await synthesizePhrases(s.voiceover.map((v) => v.text), { dataDir, fresh, voiceId });
  const track = path.join(dir, 'voice.wav');
  const durations = await assembleFromFiles(r.files, track, dir);
  for (let i = 0; i < r.files.length; i++) fs.rmSync(path.join(dir, `phrase${i}.wav`), { force: true });
  const preview = await makePreview(track, dir);
  const name = voiceName(dataDir, voiceId);
  updateJob(jobId, { status: 'voice_ready', voice: { track, durations, source: 'tts', voiceId, voiceName: name } });
  return { track, durations, preview, chars: r.chars, fromCache: r.fromCache, voiceName: name };
}

const ffmpeg = (args) => new Promise((res, rej) => spawn('ffmpeg', ['-y', '-v', 'error', ...args]).on('close', (c) => (c ? rej(new Error('ffmpeg не смог прочитать файл')) : res())));

export const CLONE_MIN_SECONDS = 10;
export const CLONE_GOOD_SECONDS = 60;
const SAMPLE_TEXT = 'Привет! Это мой голос для разборов ПДД. Проверяем, как он звучит.';

/**
 * Запись → клон голоса в ElevenLabs. Запись не обрабатывается (только перевод в mp3), чтобы клон звучал как вы.
 * Возвращает ID нового голоса, длину записи и пробную озвучку новым голосом.
 */
export async function cloneFromRecording(rawPath) {
  const dir = path.join(dataDir, 'clone');
  fs.mkdirSync(dir, { recursive: true });
  const sample = path.join(dir, 'sample.mp3');
  try {
    await ffmpeg(['-i', rawPath, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '192k', sample]);
    const seconds = await duration(sample);   // длительность по перекодированному файлу: метаданные исходника бывают неточными
    if (!(seconds >= CLONE_MIN_SECONDS)) throw new Error(`Запись слишком короткая (${Math.round(seconds || 0)} с). Нужно хотя бы ${CLONE_MIN_SECONDS} с, лучше 1–2 минуты.`);
    const name = `Голос для роликов ПДД ${new Date().toISOString().slice(0, 10)}`;
    const { voiceId, previous } = await cloneVoice(sample, { dataDir, name });
    // пробная фраза новым голосом
    const preview = await samplePreview(voiceId, dir);
    return { voiceId, seconds, previous, preview };
  } finally {
    fs.rmSync(rawPath, { force: true });
    fs.rmSync(sample, { force: true });
  }
}

/** Пробная фраза голосом (для проверки на слух). Ошибка не прерывает добавление голоса. */
async function samplePreview(voiceId, dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const r = await synthesizePhrases([SAMPLE_TEXT], { dataDir, fresh: true, voiceId });
    const preview = path.join(dir, `test-${voiceId}.ogg`);
    await ffmpeg(['-i', r.files[0], '-c:a', 'libopus', '-b:a', '48k', preview]);
    return preview;
  } catch (e) { return { error: e.message }; }
}

/** Голос из ElevenLabs по ID или ссылке: проверка через API, добавление в список бота, пробная фраза. */
export async function addLibraryVoice(text) {
  const id = parseVoiceId(text);
  if (!id) throw new Error('Не похоже на ID голоса. Пришлите ID (латинские буквы и цифры, около 20 символов) или ссылку на голос из ElevenLabs.');
  const info = await fetchVoiceInfo(id);
  addVoice(dataDir, { id: info.id, name: info.name, source: 'library' });
  const preview = await samplePreview(info.id, path.join(dataDir, 'clone'));
  return { ...info, preview };
}

export const ttsChars = (jobId) => countChars(readScenario(jobId).voiceover.map((v) => v.text), dataDir);

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
