// CLI: node src/render.mjs scenarios/q01.json [--preview|--hd|--fhd] [--voice запись.m4a | --audio трек.wav]
//                                   [--frames 1,10,20] [--workers 3] [--seconds 5] [--range 15-25]
// --preview 540x960 · --hd 720x1280 (по умолчанию) · --fhd 1080x1920
// --voice   сырая запись голоса: очищается, режется на фразы, видео подгоняется под неё
// --music файл.mp3 | --no-music   фоновая музыка (по умолчанию assets/music/default.mp3)
import fs from 'node:fs';
import path from 'node:path';
import { renderScenario, root } from './lib/render.mjs';
import { processRecording } from './lib/audio.mjs';
import { DEFAULT_MUSIC } from './lib/music.mjs';

const args = process.argv.slice(2);
const has = (n) => args.includes('--' + n);
const val = (n) => { const i = args.indexOf('--' + n); return i < 0 ? undefined : args[i + 1]; };
const file = args.find((a) => a.endsWith('.json'));
if (!file) { console.error('Укажите сценарий: node src/render.mjs scenarios/q01.json'); process.exit(1); }

const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
const name = path.basename(file, '.json');
const quality = has('preview') ? 'draft' : has('fhd') ? 'fhd' : 'hd';

let durations, audio = val('audio');
if (val('voice')) {
  console.log('Обрабатываю голос…');
  const r = await processRecording(path.resolve(val('voice')), scenario.voiceover.length, path.join(root, 'out', name + '.voice'));
  durations = r.durations; audio = r.track;
  console.log('Фразы:', durations.map((d) => d.toFixed(1) + ' c').join(', '));
}

const only = val('frames');
const res = await renderScenario({
  scenario, durations, audio, quality,
  music: has('no-music') ? undefined : (val('music') ?? DEFAULT_MUSIC),
  out: path.join(root, 'out', name + '.mp4'),
  workers: val('workers') ? +val('workers') : undefined,
  onlyFrames: only ? only.split(',').map(Number) : undefined,
  limitFrames: val('seconds') ? Math.round(+val('seconds') * 30) : undefined,
  range: val('range') ? val('range').split('-').map(Number) : undefined,
  onProgress: ({ frame, total, seconds }) => process.stdout.write(`\rкадр ${frame}/${total} (${seconds.toFixed(0)} c)`),
});
console.log('\nготово:', res.out ?? 'кадры в out/', `· длительность ${res.duration.toFixed(1)} c`);
