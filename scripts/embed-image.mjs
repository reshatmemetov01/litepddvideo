// Вшивает картинку вопроса в сценарий, чтобы файл был самодостаточным (его можно прислать боту как есть).
// node scripts/embed-image.mjs scenarios/q13.json  →  ready/q13.json
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) { console.error('Укажите сценарий: node scripts/embed-image.mjs scenarios/q13.json'); process.exit(1); }
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const img = s.card?.image;
if (img && !img.startsWith('data:')) {
  const ext = path.extname(img).slice(1).toLowerCase().replace('jpg', 'jpeg');
  s.card.image = `data:image/${ext};base64,${fs.readFileSync(img).toString('base64')}`;
}
fs.mkdirSync('ready', { recursive: true });
const out = path.join('ready', path.basename(file));
fs.writeFileSync(out, JSON.stringify(s));
console.log(out, (fs.statSync(out).size / 1024).toFixed(0) + ' КБ');
