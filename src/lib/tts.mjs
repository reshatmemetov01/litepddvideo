// Озвучка текста клонированным голосом через ElevenLabs (по фразам, с кэшем).
// Ключ и голос берутся из .env: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_ROOT = process.env.ELEVENLABS_API_ROOT ?? 'https://api.elevenlabs.io';

export const ttsConfigured = () => !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);

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
export async function synthesizePhrases(texts, { dataDir, fresh = false }) {
  const key = process.env.ELEVENLABS_API_KEY, voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) throw new TtsError('Не заданы ELEVENLABS_API_KEY и ELEVENLABS_VOICE_ID в .env');
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
