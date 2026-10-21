// Номера и наклейки на машины из моделей: российский номер по ГОСТу (тип 1) спереди и сзади,
// наклейка с логотипом на заднем стекле. Места находятся лучами по геометрии кузова, поэтому
// подходят к любой модели; высоту номеров можно уточнить в models.json (plateRear, plateFront).
import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

const FONT = 'Montserrat, "DejaVu Sans", sans-serif';

/** Номер «Е777КХ77» → картинка 520×112 мм (2 px на мм). */
function plateCanvas(text) {
  const t = text.toUpperCase().replace(/\s+/g, '');
  const m = t.match(/^(\D)(\d{3})(\D{2})(\d{2,3})$/);
  const c = document.createElement('canvas'); c.width = 1040; c.height = 224;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.beginPath(); g.roundRect(2, 2, 1036, 220, 22); g.fill();
  g.strokeStyle = '#111'; g.lineWidth = 7; g.beginPath(); g.roundRect(8, 8, 1024, 208, 18); g.stroke();
  g.fillStyle = '#111'; g.textBaseline = 'alphabetic';
  const draw = (s, size, x, y, w) => {   // текст с поджатием по ширине (номерной шрифт узкий)
    g.font = `700 ${size}px ${FONT}`;
    const k = Math.min(1, w / g.measureText(s).width);
    g.save(); g.translate(x, y); g.scale(k, 1); g.fillText(s, 0, 0); g.restore();
    return g.measureText(s).width * k;
  };
  if (m) {
    const [, a, num, bc, reg] = m;
    let x = 44;
    x += draw(a, 132, x, 184, 92) + 18;
    x += draw(num, 172, x, 190, 330) + 18;
    draw(bc, 132, x, 184, 200);
    g.fillRect(782, 10, 6, 204);
    g.textAlign = 'center';
    g.font = `700 112px ${FONT}`;
    const rw = Math.min(1, 210 / g.measureText(reg).width);
    g.save(); g.translate(910, 128); g.scale(rw, 1); g.fillText(reg, 0, 0); g.restore();
    g.font = `700 34px ${FONT}`; g.fillText('RUS', 878, 196);
    [['#fff', 0], ['#1c3fa6', 1], ['#d52b1e', 2]].forEach(([cl, i]) => { g.fillStyle = cl; g.fillRect(934, 170 + i * 9, 40, 9); });
    g.strokeStyle = '#111'; g.lineWidth = 2; g.strokeRect(934, 170, 40, 27);
  } else {
    g.textAlign = 'center'; draw(t, 150, 520 - Math.min(940, t.length * 95) / 2, 182, 940);
  }
  return c;
}

/** Наклейка: значок Telegram и ник белым на прозрачном фоне. */
function stickerCanvas(text) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.font = `800 150px ${FONT}`;
  const tw = Math.min(760, g.measureText(text).width);
  const x0 = (1024 - (200 + 36 + tw)) / 2;
  // значок Telegram: голубой круг с белым «самолётиком»
  g.fillStyle = '#2aabee'; g.beginPath(); g.arc(x0 + 100, 128, 100, 0, Math.PI * 2); g.fill();
  g.save(); g.translate(x0, 28); g.scale(2, 2);
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(22, 49); g.lineTo(76, 28); g.lineTo(67, 73); g.lineTo(50, 61); g.lineTo(43, 68); g.lineTo(42, 57); g.lineTo(65, 37); g.lineTo(37, 54); g.closePath(); g.fill();
  g.fillStyle = '#c8daea'; g.beginPath(); g.moveTo(42, 57); g.lineTo(43, 68); g.lineTo(50, 61); g.closePath(); g.fill();
  g.restore();
  g.fillStyle = '#fff'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineJoin = 'round';
  g.save(); g.translate(x0 + 236, 136); g.scale(tw / g.measureText(text).width, 1); g.strokeText(text, 0, 0); g.fillText(text, 0, 0); g.restore();
  return c;
}

const tex = (canvas) => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };

/**
 * Номера и наклейка для машины. root — машина (вперёд +x, левый борт −z, земля y = 0), body — кузов.
 * Вызывать сразу после сборки, пока root в начале координат.
 */
// случайный, но постоянный для объекта номер: буквы, которые есть и в кириллице, и в латинице (как на настоящих номерах)
const PLATE_LETTERS = 'АВЕКМНОРСТУХ';
const REGIONS = ['77', '97', '99', '177', '197', '777', '50', '150', '190', '750', '78', '98', '178', '23', '61', '16', '02', '52', '66', '74'];
function randomPlate(seedText) {
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const next = (n) => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = (h ^ (h >>> 13)) >>> 0; return h % n; };
  const L = () => PLATE_LETTERS[next(PLATE_LETTERS.length)];
  const num = String(1 + next(999)).padStart(3, '0');
  return `${L()}${num}${L()}${L()}${REGIONS[next(REGIONS.length)]}`;
}

export function addBranding(root, body, def, cfg, size) {
  // номер по умолчанию — случайный российский; "plate": false — оставить номер модели
  if (def.plate === undefined && !['tram', 'moto'].includes(def.type)) def = { ...def, plate: randomPlate(String(def.id ?? '')) };   // у мотоцикла номер маленький и только сзади — не ставим
  if (!def.plate && !def.sticker) return;
  root.updateMatrixWorld(true);
  const parts = [];
  body.traverse((o) => { if (o.isMesh && o.visible && !/^__wheel|wheel/i.test(o.parent?.name ?? '')) parts.push(o); });
  const ray = new THREE.Raycaster();
  const L = size.x / 2 + 1;
  const hit = (origin, dir, list = parts) => { ray.set(origin, dir); return ray.intersectObjects(list, false)[0]; };
  const normalOf = (h) => h.face.normal.clone().transformDirection(h.object.matrixWorld);

  if (def.plate) {
    const map = tex(plateCanvas(def.plate));
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.35, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 });
    const frame = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    for (const [front, y] of [[false, cfg.plateRear ?? 0.55], [true, cfg.plateFront ?? 0.4]]) {
      const s = front ? 1 : -1;
      const h = hit(new THREE.Vector3(s * L, y, 0), new THREE.Vector3(-s, 0, 0));
      if (!h) continue;
      const n = normalOf(h); n.y *= 0.3; n.normalize();
      if (n.x * s < 0.3) n.set(s, 0, 0);   // попали в бок или в решётку под углом — ставим ровно
      const g = new THREE.Group();
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.112), mat);
      plate.position.z = 0.006;
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.535, 0.125, 0.01), frame);
      g.add(back, plate);
      g.position.copy(h.point).addScaledVector(n, 0.012);
      g.lookAt(g.position.clone().add(n));
      g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
      body.add(g);
    }
  }

  if (def.sticker) {
    // заднее стекло: горизонтальные лучи сзади на разных высотах, первое попадание — в стекло
    const glassRe = new RegExp(cfg.glass ?? 'glass|window|стекл', 'i');
    const isGlass = (o) => glassRe.test(o.material?.name ?? '') || glassRe.test(o.name);
    const hits = [];
    for (let y = size.y * 0.97; y > size.y * 0.5; y -= 0.02) {
      const h = hit(new THREE.Vector3(-L, y, 0), new THREE.Vector3(1, 0, 0));
      if (h && isGlass(h.object)) hits.push({ y, h });
    }
    if (hits.length) {
      const { h } = hits[Math.floor(hits.length * 0.55)];   // чуть ниже середины стекла
      const n = normalOf(h);
      const helper = new THREE.Object3D();
      helper.position.copy(h.point); helper.lookAt(h.point.clone().add(n));
      const w = Math.min(0.75, size.z * 0.48);
      const geo = new DecalGeometry(h.object, h.point, helper.rotation, new THREE.Vector3(w, w / 4, 0.4));
      // геометрия посчитана в мировых координатах (= координатах машины): переводим в систему кузова
      geo.applyMatrix4(body.matrixWorld.clone().invert());
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: tex(stickerCanvas(def.sticker)), transparent: true, depthWrite: false, roughness: 0.4,
        polygonOffset: true, polygonOffsetFactor: -4,
      }));
      m.renderOrder = 1;
      body.add(m);
    }
  }
}
