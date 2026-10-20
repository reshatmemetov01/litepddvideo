// Скачивает бесплатные ресурсы Poly Haven (CC0) по assets/manifest.json в assets/ext/.
// Уже скачанное пропускается. Запуск: node scripts/fetch-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'manifest.json'), 'utf8'));
const out = path.join(root, 'assets', 'ext');

async function get(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
      fs.renameSync(dest + '.part', dest);
      return true;
    } catch (e) {
      if (attempt === 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
const files = async (id) => (await fetch(`https://api.polyhaven.com/files/${id}`)).json();

let n = 0;
for (const h of manifest.hdri) {
  const f = await files(h.id);
  if (await get(f.hdri[h.res].hdr.url, path.join(out, 'hdri', `${h.id}.hdr`))) n++;
}
for (const t of manifest.textures) {
  const f = await files(t.id);
  for (const m of t.maps) {
    const src = f[m]?.[t.res]?.jpg?.url;
    if (!src) throw new Error(`${t.id}: нет карты ${m} ${t.res}`);
    if (await get(src, path.join(out, 'textures', t.id, `${m.toLowerCase()}.jpg`))) n++;
  }
}
for (const m of manifest.models) {
  const g = (await files(m.id)).gltf[m.res].gltf;
  const dir = path.join(out, 'models', m.id);
  if (await get(g.url, path.join(dir, path.basename(new URL(g.url).pathname)))) n++;
  for (const [rel, inc] of Object.entries(g.include ?? {})) if (await get(inc.url, path.join(dir, rel))) n++;
}
console.log(`ресурсы готовы (скачано файлов: ${n}) → ${path.relative(root, out)}`);
