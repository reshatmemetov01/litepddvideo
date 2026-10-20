// Озвучка текста клонированным голосом через ElevenLabs (по фразам, с кэшем).
// Ключ и голос берутся из .env: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_ROOT = process.env.ELEVENLABS_API_ROOT ?? 'https://api.elevenlabs.io';

// ---- голоса ----
// data/voices.json: { active, voices: [{ id, name, source: 'clone' | 'library', addedAt }] }
// Активный голос используется по умолчанию; если список пуст — ELEVENLABS_VOICE_ID из .env.
const voicesFile = (dataDir) => path.join(dataDir, 'voices.json');
const legacyFile = (dataDir) => path.join(dataDir, 'voice.json');

export function loadVoices(dataDir) {
  try { return JSON.parse(fs.readFileSync(voicesFile(dataDir), 'utf8')); } catch { /* ещё нет */ }
  // перенос со старого формата (один клон в voice.json)
  try {
    const old = JSON.parse(fs.readFileSync(legacyFile(dataDir), 'utf8'));
    const reg = { active: old.voiceId, voices: [{ id: old.voiceId, name: old.name ?? 'Мой голос', source: 'clone', addedAt: old.createdAt ?? Date.now() }] };
    saveVoices(dataDir, reg);
    fs.rmSync(legacyFile(dataDir), { force: true });
    return reg;
  } catch { return { active: null, voices: [] }; }
}
function saveVoices(dataDir, reg) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(voicesFile(dataDir), JSON.stringify(reg, null, 1));
}
export function addVoice(dataDir, voice, { makeActive = true } = {}) {
  const reg = loadVoices(dataDir);
  reg.voices = reg.voices.filter((v) => v.id !== voice.id);
  reg.voices.push({ ...voice, addedAt: Date.now() });
  if (makeActive || !reg.active) reg.active = voice.id;
  saveVoices(dataDir, reg);
  return reg;
}
export function setActiveVoice(dataDir, id) {
  const reg = loadVoices(dataDir);
  if (!reg.voices.some((v) => v.id === id)) return false;
  reg.active = id;
  saveVoices(dataDir, reg);
  return true;
}
/** Убирает голос из списка бота (в ElevenLabs он остаётся). */
export function removeVoice(dataDir, id) {
  const reg = loadVoices(dataDir);
  reg.voices = reg.voices.filter((v) => v.id !== id);
  if (reg.active === id) reg.active = reg.voices.at(-1)?.id ?? null;
  saveVoices(dataDir, reg);
  return reg;
}
export function currentVoice(dataDir) {
  const reg = loadVoices(dataDir);
  const v = reg.voices.find((x) => x.id === reg.active);
  if (v) return v;
  return process.env.ELEVENLABS_VOICE_ID ? { id: process.env.ELEVENLABS_VOICE_ID, name: 'Голос из .env', source: 'env' } : null;
}
export const voiceName = (dataDir, id) => loadVoices(dataDir).voices.find((v) => v.id === id)?.name ?? (id === process.env.ELEVENLABS_VOICE_ID ? 'Голос из .env' : id);
export const currentVoiceId = (dataDir) => currentVoice(dataDir)?.id ?? null;
export const ttsKeySet = () => !!process.env.ELEVENLABS_API_KEY;
export const ttsConfigured = (dataDir) => ttsKeySet() && !!currentVoiceId(dataDir);

/** ID голоса из текста: сам ID или ссылка из ElevenLabs (…voiceId=XXXX или …/voices/XXXX). */
export function parseVoiceId(text) {
  const t = text.trim();
  const fromUrl = t.match(/[?&](?:voiceId|voice_id)=([A-Za-z0-9]{10,40})/) ?? t.match(/\/voices?\/([A-Za-z0-9]{10,40})(?:[/?#]|$)/);
  if (fromUrl) return fromUrl[1];
  return /^[A-Za-z0-9]{10,40}$/.test(t) ? t : null;
}

/** Проверяет, что голос доступен этому ключу, и возвращает его название. */
export async function fetchVoiceInfo(id) {
  const res = await fetch(`${API_ROOT}/v1/voices/${encodeURIComponent(id)}`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
  const body = await res.text();
  if (res.status === 401) throw new TtsError(explain(401, body));
  if (res.status === 400 || res.status === 404) {
    throw new TtsError('Голос с таким ID недоступен вашему аккаунту. Если это голос из библиотеки ElevenLabs (Voice Library), сначала добавьте его к себе («Add to my voices» / «Добавить в мои голоса»), потом пришлите ID ещё раз.');
  }
  if (!res.ok) throw new TtsError(explain(res.status, body));
  const j = JSON.parse(body);
  return { id: j.voice_id ?? id, name: j.name ?? id, category: j.category };
}

export function voiceSettings() {
  const n = (k, d) => (process.env[k] !== undefined ? +process.env[k] : d);
  return {
    model: process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2',
    settings: {
      stability: n('ELEVENLABS_STABILITY', 0.45),
      similarity_boost: n('ELEVENLABS_SIMILARITY', 0.8),
      style: n('ELEVENLABS_STYLE', 0.2),
      use_speaker_boost: true,
    },
  };
}

/** Словарь произношения: assets/pronunciation.json + (необязательно) data/pronunciation.json */
function loadDictionary(dataDir) {
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
  return { ...read(path.join(root, 'assets', 'pronunciation.json')), ...read(path.join(dataDir, 'pronunciation.json')) };
}

/** Текст для озвучки: без цветовой разметки субтитров, с исправленным произношением. */
export function speechText(text, dictionary = {}) {
  let t = text.replace(/\[\/?[gry]\]/g, '').replace(/\s+/g, ' ').trim();
  for (const [word, say] of Object.entries(dictionary)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`(?<![\\p{L}\\d])${esc}(?![\\p{L}\\d])`, 'gu'), say);
  }
  return t;
}

class TtsError extends Error {}

function explain(status, body) {
  const detail = (() => { try { const j = JSON.parse(body); return j.detail?.message ?? j.detail?.status ?? JSON.stringify(j.detail ?? j); } catch { return body.slice(0, 200); } })();
  if (status === 401) return 'ElevenLabs не принял ключ API (неверный или удалён). Проверьте ELEVENLABS_API_KEY.';
  if (/quota/i.test(detail) || status === 402) return 'В ElevenLabs закончились символы или тариф не позволяет озвучку. Проверьте подписку.';
  if (status === 404 || /voice.*not.*found/i.test(detail)) return 'Голос с таким ELEVENLABS_VOICE_ID не найден в аккаунте.';
  if (status === 422) return `ElevenLabs не принял запрос: ${detail}`;
  return `ElevenLabs вернул ошибку ${status}: ${detail}`;
}

async function callTts(text, key, voiceId) {
  const { model, settings } = voiceSettings();
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API_ROOT}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: model, voice_settings: settings }),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    throw new TtsError(explain(res.status, body));
  }
}

/**
 * Озвучивает фразы по одной. Одинаковый текст с теми же настройками берётся из кэша и символы не тратит.
 * @returns {{files: string[], chars: number, fromCache: number}} chars — сколько символов реально списано
 */
export async function synthesizePhrases(texts, { dataDir, fresh = false, voiceId = currentVoiceId(dataDir) }) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new TtsError('Не задан ELEVENLABS_API_KEY в .env');
  if (!voiceId) throw new TtsError('Голос не выбран: склонируйте его командой /clone');
  const cacheDir = path.join(dataDir, 'tts-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const dict = loadDictionary(dataDir);
  const { model, settings } = voiceSettings();
  const files = [];
  let chars = 0, fromCache = 0;
  for (const raw of texts) {
    const text = speechText(raw, dict);
    const hash = crypto.createHash('sha256').update(JSON.stringify([text, voiceId, model, settings])).digest('hex').slice(0, 24);
    const file = path.join(cacheDir, `${hash}.mp3`);
    if (!fresh && fs.existsSync(file)) { fromCache++; files.push(file); continue; }
    fs.writeFileSync(file, await callTts(text, key, voiceId));
    chars += text.length;
    files.push(file);
  }
  return { files, chars, fromCache };
}

/** Сколько символов потратит озвучка (без учёта кэша). */
export const countChars = (texts, dataDir) => { const d = loadDictionary(dataDir); return texts.reduce((s, t) => s + speechText(t, d).length, 0); };

/** Остаток символов в аккаунте (если у ключа есть доступ). */
export async function getUsage() {
  try {
    const res = await fetch(`${API_ROOT}/v1/user/subscription`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
    if (!res.ok) return null;
    const j = await res.json();
    return { used: j.character_count, limit: j.character_limit };
  } catch { return null; }
}

/** Создаёт клон голоса (Instant Voice Clone) по записи и запоминает его ID для озвучки. */
export async function cloneVoice(audioFile, { dataDir, name }) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new TtsError('Не задан ELEVENLABS_API_KEY в .env');
  const form = new FormData();
  form.append('name', name);
  form.append('remove_background_noise', 'false');   // микрофон чистый, шумодав только испортит тембр
  form.append('files', new Blob([fs.readFileSync(audioFile)], { type: 'audio/mpeg' }), path.basename(audioFile));
  const res = await fetch(`${API_ROOT}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': key }, body: form });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 401) throw new TtsError(explain(401, body));
    if ([400, 402, 403].includes(res.status)) throw new TtsError(`ElevenLabs не создал клон (${res.status}). Скорее всего, на вашем тарифе нет клонирования голоса или закончились слоты для голосов. Ответ: ${body.slice(0, 200)}`);
    throw new TtsError(explain(res.status, body));
  }
  const voiceId = JSON.parse(body).voice_id;
  const previous = loadVoices(dataDir).voices.find((v) => v.source === 'clone') ?? null;
  addVoice(dataDir, { id: voiceId, name, source: 'clone' });
  return { voiceId, previous };
}
