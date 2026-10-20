// Создаёт клон голоса в ElevenLabs и печатает Voice ID (то же делает команда /clone в боте).
// ELEVENLABS_API_KEY=... node scripts/clone-voice.mjs "Мой голос" запись.mp3
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneVoice } from '../src/lib/tts.mjs';

const [name, file] = process.argv.slice(2);
if (!process.env.ELEVENLABS_API_KEY || !name || !file) {
  console.error('Использование: ELEVENLABS_API_KEY=... node scripts/clone-voice.mjs "Название" запись.mp3');
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));
try {
  const { voiceId } = await cloneVoice(file, { dataDir: tmp, name });
  console.log('Готово. Voice ID:', voiceId);
  console.log('Впишите его в .env: ELEVENLABS_VOICE_ID=' + voiceId);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
