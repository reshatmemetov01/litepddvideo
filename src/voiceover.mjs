// Выгружает текст озвучки сценария с таймкодами: node src/voiceover.mjs scenarios/q01.json
// Этот текст отдаёте в платный сервис озвучки; готовый файл кладёте в audio/<имя сценария>.mp3
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) { console.error('Укажите сценарий'); process.exit(1); }
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const strip = (t) => t.replace(/\[\/?[gry]\]/g, '');
const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const lines = s.voiceover.map((v) => `[${fmt(v.t0)}–${fmt(v.t1)}] ${strip(v.text)}`);
if (s.cta) lines.push(`[${fmt(s.cta.t0)}–${fmt(s.cta.t1)}] ${strip(s.cta.text)}. ${s.cta.sub ?? ''}`);
const out = path.join('out', path.basename(file, '.json') + '.voiceover.txt');
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log('\n→', out);
