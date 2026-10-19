// Обработка записи голоса: очистка → нарезка на фразы по паузам → сборка дорожки с ровными паузами.
// Вход: одна запись, где фразы озвучки прочитаны по порядку с паузой между ними (≥ ~1 с).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAD_IN, GAP } from './timeline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RNNOISE_MODEL = path.join(root, 'assets', 'rnnoise.rnnn');

export class AudioSplitError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} завершился с кодом ${code}: ${err.slice(-600)}`))));
  });
}

export async function duration(file) {
  const { out } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(out);
}

/**
 * Очистка голоса. Режимы (VOICE_CLEAN в .env):
 *  off   — только срез инфранизов (оригинальный тембр без изменений)
 *  light — срез низов + очень мягкое шумоподавление (по умолчанию)
 *  full  — шумодав RNNoise, коррекция тембра, компрессия (для шумных записей)
 */
export const CLEAN_MODES = {
  off: 'highpass=f=60',
  light: 'highpass=f=70,afftdn=nr=4:nf=-55',
  full: [
    'highpass=f=85',
    fs.existsSync(RNNOISE_MODEL) ? `arnndn=m=${RNNOISE_MODEL}:mix=0.95,afftdn=nr=6:nf=-45` : 'afftdn=nr=18:nf=-35:tn=1',
    'lowpass=f=12000',
    'equalizer=f=220:t=q:w=1.0:g=-2',
    'equalizer=f=3200:t=q:w=1.0:g=2.5',
    'equalizer=f=7500:t=q:w=1.5:g=-2',
    'acompressor=threshold=-21dB:ratio=3:attack=6:release=90:makeup=4',
  ].join(','),
};

export async function cleanVoice(input, output, mode = process.env.VOICE_CLEAN ?? 'light') {
  const chain = CLEAN_MODES[mode];
  if (!chain) throw new Error(`VOICE_CLEAN: неизвестный режим «${mode}» (off, light, full)`);
  await run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-af', chain, output]);
}

async function silences(wav, noiseDb, minSilence) {
  const { err } = await run('ffmpeg', ['-v', 'info', '-i', wav, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, '-f', 'null', '-']);
  const starts = [...err.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Math.max(0, +m[1]));
  const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  return { starts, ends };
}

function speechSegments(sil, total, minSpeech = 0.3) {
  const segs = [];
  let cursor = 0;
  for (let i = 0; i < sil.starts.length; i++) {
    if (sil.starts[i] - cursor > 0) segs.push([cursor, sil.starts[i]]);
    cursor = sil.ends[i] ?? total;
  }
  if (total - cursor > 0) segs.push([cursor, total]);
  return segs.filter(([a, b]) => b - a >= minSpeech);
}

/** Подбирает порог тишины так, чтобы число фраз совпало с ожидаемым. */
export async function splitPhrases(wav, expected) {
  const total = await duration(wav);
  const results = [];
  for (const minSil of [1.4, 1.1, 0.9, 0.75, 0.6, 0.5, 0.4]) {
    for (const noise of [-38, -34, -42, -30, -46]) {
      const segs = speechSegments(await silences(wav, noise, minSil), total);
      results.push({ minSil, noise, segs });
      if (segs.length === expected) return { segs, total, minSil, noise };
    }
  }
  const counts = [...new Set(results.map((r) => r.segs.length))];
  const closest = counts.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected))[0];
  throw new AudioSplitError(`В записи нашлось фраз: ${closest} (нужно ${expected})`, { expected, found: counts });
}

/** Вырезает фразы, ставит ровные паузы (LEAD_IN/GAP как в таймлайне), выравнивает громкость. */
export async function assembleTrack(wav, segs, output) {
  const PAD_BEFORE = 0.08, PAD_AFTER = 0.14;
  const total = await duration(wav);
  const bounds = segs.map(([a, b], i) => {
    const prevEnd = i ? segs[i - 1][1] : 0, nextStart = i < segs.length - 1 ? segs[i + 1][0] : total;
    return [Math.max(prevEnd + (a - prevEnd) / 2, a - PAD_BEFORE), Math.min(nextStart - (nextStart - b) / 2, b + PAD_AFTER)];
  });
  const filters = [], labels = [];
  const sil = (name, d) => { filters.push(`anullsrc=r=44100:cl=mono,atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS[${name}]`); labels.push(`[${name}]`); };
  sil('lead', LEAD_IN);
  bounds.forEach(([a, b], i) => {
    const len = b - a;
    filters.push(`[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=${(len - 0.06).toFixed(3)}:d=0.06[s${i}]`);
    labels.push(`[s${i}]`);
    if (i < bounds.length - 1) sil(`g${i}`, GAP);
  });
  filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=9,aresample=44100[out]`);
  await run('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-filter_complex', filters.join(';'), '-map', '[out]', '-ac', '1', output]);
  return bounds.map(([a, b]) => b - a);
}

/** Полный цикл: запись → чистый трек + длительности фраз. */
export async function processRecording(input, expectedPhrases, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const clean = path.join(workDir, 'clean.wav');
  const track = path.join(workDir, 'voice.wav');
  await cleanVoice(input, clean);
  const { segs } = await splitPhrases(clean, expectedPhrases);
  const durations = await assembleTrack(clean, segs, track);
  return { track, durations, cleaned: clean };
}
