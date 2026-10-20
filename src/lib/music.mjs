// Фоновая музыка: тихо под голосом, с «приседанием» на речи, без пауз внутри трека.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_MUSIC = path.join(root, 'assets', 'music', 'default.mp3');
// Громкость музыки (LUFS). Голос выравнивается до −16, музыка по умолчанию на ~19 дБ тише — «едва слышно».
export const MUSIC_LUFS = () => +(process.env.MUSIC_LUFS ?? -35);

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c ? reject(new Error(`ffmpeg: ${err.slice(-400)}`)) : resolve(err)));
  });
}

const loudnessCache = new Map();
/** Средняя громкость трека (LUFS); считается один раз на файл. */
export async function measureLoudness(file) {
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  if (!loudnessCache.has(key)) {
    const err = await run(['-hide_banner', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
    const i = parseFloat(err.match(/"input_i"\s*:\s*"(-?[\d.]+)"/)?.[1]);
    loudnessCache.set(key, Number.isFinite(i) ? i : -16);
  }
  return loudnessCache.get(key);
}

/**
 * Собирает звук ролика: голос (если есть) + тихая музыка (если есть) → mp4 с видео без пересжатия.
 * Музыка: паузы внутри трека вырезаются, трек зацикливается, плавное начало и конец,
 * под голосом приглушается ещё сильнее (sidechain).
 */
export async function mixAudio({ video, voice, music, duration, out }) {
  const D = duration.toFixed(3);
  const inputs = ['-i', video];
  const filters = [];
  let mapA = null;
  if (voice) inputs.push('-i', voice);
  if (music) {
    const gain = MUSIC_LUFS() - (await measureLoudness(music));
    inputs.push('-stream_loop', '-1', '-i', music);
    const mi = voice ? 2 : 1;
    filters.push(
      `[${mi}:a]silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_duration=0.15:stop_threshold=-45dB:stop_silence=0.05,` +
      `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${gain.toFixed(2)}dB,` +
      `afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, duration - 2.5).toFixed(3)}:d=2.5[m]`,
    );
  }
  if (voice) filters.push('[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[v]');
  if (voice && music) {
    filters.push('[v]asplit=2[vo][sc]', '[m][sc]sidechaincompress=threshold=0.02:ratio=4:attack=20:release=500[md]',
      '[vo][md]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.97[a]');
    mapA = '[a]';
  } else if (voice) mapA = '[v]';
  else if (music) mapA = '[m]';
  if (!mapA) { fs.copyFileSync(video, out); return; }
  await run(['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', mapA,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', D, out]);
}
