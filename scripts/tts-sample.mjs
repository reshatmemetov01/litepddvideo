// Проверка озвучки без бота: ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... node scripts/tts-sample.mjs "Текст" out.mp3
import fs from 'node:fs';
import { synthesizePhrases } from '../src/lib/tts.mjs';
const [text, out = 'sample.mp3'] = process.argv.slice(2);
if (!text) { console.error('Укажите текст'); process.exit(1); }
const dir = fs.mkdtempSync('/tmp/tts-sample-');
const r = await synthesizePhrases([text], { dataDir: dir, fresh: true });
fs.copyFileSync(r.files[0], out);
console.log(`Готово: ${out} (списано ${r.chars} симв.)`);
fs.rmSync(dir, { recursive: true, force: true });
