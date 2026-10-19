// Создаёт клон голоса в ElevenLabs (Instant Voice Clone) и печатает Voice ID.
// ELEVENLABS_API_KEY=... node scripts/clone-voice.mjs "Мой голос" запись1.mp3 [запись2.mp3 ...]
// Нужен платный тариф с клонированием. Загружайте исходные записи (не обработанные шумодавом), от 1 минуты.
import fs from 'node:fs';
import path from 'node:path';

const [name, ...files] = process.argv.slice(2);
const key = process.env.ELEVENLABS_API_KEY;
const root = process.env.ELEVENLABS_API_ROOT ?? 'https://api.elevenlabs.io';
if (!key || !name || !files.length) {
  console.error('Использование: ELEVENLABS_API_KEY=... node scripts/clone-voice.mjs "Название" запись.mp3 [...]');
  process.exit(1);
}
const form = new FormData();
form.append('name', name);
form.append('remove_background_noise', 'false');   // ваш микрофон чистый, не портим тембр
for (const f of files) form.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));

const res = await fetch(`${root}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': key }, body: form });
const text = await res.text();
if (!res.ok) {
  console.error(`Ошибка ${res.status}: ${text.slice(0, 500)}`);
  if (res.status === 401) console.error('Ключ не принят.');
  if (res.status === 400 || res.status === 402 || res.status === 403) console.error('Возможно, на вашем тарифе недоступно клонирование голоса.');
  process.exit(1);
}
console.log('Готово. Voice ID:', JSON.parse(text).voice_id);
console.log('Впишите его в .env: ELEVENLABS_VOICE_ID=' + JSON.parse(text).voice_id);
