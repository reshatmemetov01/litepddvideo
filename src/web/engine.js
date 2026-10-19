// Движок сцены: строит 3D-мир по JSON-сценарию и умеет отрисовать любой момент времени t.
// Всё детерминировано: renderAt(t) не зависит от реального времени, поэтому кадры можно
// снимать по одному (render.mjs) и собирать в видео.
import * as THREE from 'three';

const W = 8;          // ширина проезжей части (2 полосы по 4 м)
const SIDEWALK = 4;   // ширина тротуара
const FAR = 70;       // длина дорог от центра

// ---------- утилиты ----------
const col = (c) => (typeof c === 'string' ? Number(c) : c);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => a + (b - a) * u;
const lerpAngle = (a, b, u) => {
  let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * u;
};

function mat(color, opts = {}) {
  return new THREE.MeshLambertMaterial({ color, ...opts });
}
function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ---------- мир ----------
function buildGround(scene, roads) {
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat(0x6cc04a));
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  scene.add(grass);

  const hasX = roads.includes('x');
  const hasZ = roads.includes('z');
  const asphalt = 0x4a4d55;
  const curb = 0xc4a08a;

  const addRoad = (alongX) => {
    const g = new THREE.Group();
    const road = box(FAR * 2, 0.1, W, asphalt, 0, 0.05, 0);
    g.add(road);
    // тротуары
    for (const s of [-1, 1]) {
      g.add(box(FAR * 2, 0.25, SIDEWALK, curb, 0, 0.125, s * (W / 2 + SIDEWALK / 2)));
    }
    // осевая — пунктир
    for (let i = -FAR; i < FAR; i += 6) {
      g.add(box(3, 0.02, 0.2, 0xf4f4f4, i + 1.5, 0.11, 0));
    }
    if (!alongX) g.rotation.y = Math.PI / 2;
    scene.add(g);
  };
  if (hasX) addRoad(true);
  if (hasZ) addRoad(false);

  // центр перекрёстка закрываем чистым асфальтом, чтобы не торчали тротуары/разметка
  if (hasX && hasZ) {
    scene.add(box(W, 0.3, W, asphalt, 0, 0.15, 0));
    // стоп-линии
    for (const [x, z, rot] of [[2, W / 2 + 0.6, 0], [-2, -W / 2 - 0.6, 0], [W / 2 + 0.6, -2, 1], [-W / 2 - 0.6, 2, 1]]) {
      const l = box(4, 0.02, 0.4, 0xf4f4f4, x, 0.32, z);
      if (rot) l.rotation.y = Math.PI / 2, l.position.set(x, 0.32, z);
      scene.add(l);
    }
  }
}

function addCrosswalk(scene, z) {
  // зебра на дороге вдоль оси z: полосы параллельны движению, пешеход идёт вдоль x
  for (let i = -3; i <= 3; i++) {
    scene.add(box(0.65, 0.03, 4, 0xf4f4f4, i * 1.15, 0.12, z));
  }
}

function windowsTexture(base, rows, cols) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 128, 256);
  const ww = 128 / cols, hh = 256 / rows;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      g.fillStyle = Math.random() > 0.15 ? '#7ab6e0' : '#f6d98a';
      g.fillRect(k * ww + ww * 0.2, r * hh + hh * 0.2, ww * 0.6, hh * 0.55);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function addBuilding(scene, x, z, w, d, h) {
  const palette = ['#e9d9a8', '#d9c48f', '#cfd6dc', '#e0b9a0'];
  const base = palette[Math.floor(rnd() * palette.length)];
  const tex = windowsTexture(base, Math.max(2, Math.round(h / 3.2)), Math.max(2, Math.round(w / 3)));
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(0xffffff, { map: tex }));
  m.position.set(x, h / 2, z);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  scene.add(box(w + 0.6, 0.5, d + 0.6, 0x8c6a5a, x, h + 0.25, z));
}

function addTree(scene, x, z, s = 1) {
  const g = new THREE.Group();
  g.add(box(0.5 * s, 2 * s, 0.5 * s, 0x7a5230, 0, 1 * s, 0));
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.9 * s, 0), mat(0x3f9e3a));
  crown.position.y = 3.6 * s; crown.castShadow = true;
  g.add(crown);
  const crown2 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.3 * s, 0), mat(0x58b84a));
  crown2.position.set(0.8 * s, 4.7 * s, 0.3 * s); crown2.castShadow = true;
  g.add(crown2);
  g.position.set(x, 0.25, z);
  scene.add(g);
}

function buildScenery(scene, roads) {
  const hasX = roads.includes('x'), hasZ = roads.includes('z');
  const off = W / 2 + SIDEWALK + 2;
  if (hasX && hasZ) {
    // четыре квартала по углам
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = sx * (off + 12), cz = sz * (off + 12);
        addBuilding(scene, cx, cz, 14, 14, 9 + rnd() * 9);
        addBuilding(scene, cx + sx * 20, cz, 14, 14, 8 + rnd() * 8);
        addBuilding(scene, cx, cz + sz * 20, 14, 14, 8 + rnd() * 8);
        addTree(scene, sx * (W / 2 + 2.2), sz * (W / 2 + 9), 1);
        addTree(scene, sx * (W / 2 + 9), sz * (W / 2 + 2.2), 1.1);
        addTree(scene, sx * (W / 2 + 2.2), sz * (W / 2 + 22), 1);
        addTree(scene, sx * (W / 2 + 22), sz * (W / 2 + 2.2), 1);
      }
    }
  } else if (hasZ) {
    for (const sx of [-1, 1]) {
      for (let z = -60; z <= 60; z += 20) {
        addBuilding(scene, sx * (off + 9), z, 14, 16, 8 + rnd() * 10);
        if (sx < 0 || Math.abs(z) > 30) addTree(scene, sx * (W / 2 + 2.2), z + 8, 1);
        if (sx < 0) addTree(scene, sx * (W / 2 + 2.2), z - 4, 0.9);
      }
    }
  } else {
    for (const sz of [-1, 1]) {
      for (let x = -60; x <= 60; x += 20) {
        addBuilding(scene, x, sz * (off + 9), 16, 14, 8 + rnd() * 10);
        addTree(scene, x + 8, sz * (W / 2 + 2.2), 1);
      }
    }
  }
}

// ---------- знаки ----------
function signTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  const poly = (pts, fill, stroke, lw) => {
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.lineJoin = 'round'; g.stroke(); }
  };
  if (kind === 'main_road') {            // 2.1 Главная дорога
    poly([[128, 8], [248, 128], [128, 248], [8, 128]], '#fff', '#111', 10);
    poly([[128, 36], [220, 128], [128, 220], [36, 128]], '#f6c500', null, 0);
    poly([[128, 36], [220, 128], [128, 220], [36, 128]], null, '#111', 8);
  } else if (kind === 'yield') {         // 2.4 Уступите дорогу
    poly([[16, 36], [240, 36], [128, 230]], '#fff', '#d32020', 26);
    poly([[16, 36], [240, 36], [128, 230]], '#fff', null, 0);
  } else if (kind === 'stop') {          // 2.5 Движение без остановки запрещено
    const pts = [];
    for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * Math.PI) / 4; pts.push([128 + 118 * Math.cos(a), 128 + 118 * Math.sin(a)]); }
    poly(pts, '#d32020', '#fff', 8);
    g.fillStyle = '#fff'; g.font = 'bold 62px Montserrat, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('STOP', 128, 132);
  } else if (kind === 'ped_crossing') {  // 5.19.1 Пешеходный переход
    g.fillStyle = '#1b57c4'; g.beginPath(); g.roundRect(16, 16, 224, 224, 22); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 8; g.beginPath(); g.roundRect(22, 22, 212, 212, 18); g.stroke();
    poly([[128, 44], [208, 196], [48, 196]], '#fff', '#111', 8);
    poly([[128, 68], [188, 184], [68, 184]], '#f6c500', null, 0);
    g.fillStyle = '#111';
    g.beginPath(); g.arc(130, 106, 11, 0, 7); g.fill();
    g.fillRect(122, 120, 16, 34);
    g.save(); g.translate(130, 154); g.rotate(0.35); g.fillRect(-14, 0, 12, 30); g.rotate(-0.7); g.fillRect(2, 0, 12, 30); g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeSign(def) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3, 8), mat(0x999999));
  pole.position.y = 1.5; pole.castShadow = true;
  g.add(pole);
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({ map: signTexture(def.type), transparent: true, side: THREE.DoubleSide, alphaTest: 0.1 })
  );
  face.position.set(0, 3.0, 0);
  g.add(face);
  g.position.set(def.pos[0], 0.25, def.pos[1]);
  g.rotation.y = ((def.rot ?? 0) * Math.PI) / 180;  // 0 = знак смотрит на +z (на зрителя снизу)
  return g;
}

// ---------- транспорт ----------
const CAR_COLORS = { blue: 0x3b4cc0, red: 0xd2352f, white: 0xeeeeee, black: 0x222428, yellow: 0xf0b400, green: 0x2f9e5b, grey: 0x8a8f98 };

function makeVehicle(def) {
  const g = new THREE.Group();   // вперёд = +x
  const color = CAR_COLORS[def.color] ?? col(def.color) ?? 0x3b4cc0;
  const glass = 0x9cc8e6;
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 14);
  const wheel = (x, z) => {
    const w = new THREE.Mesh(wheelGeo, mat(0x15161a));
    w.rotation.x = Math.PI / 2; w.position.set(x, 0.42, z); w.castShadow = true; g.add(w);
  };
  if (def.type === 'bus') {
    g.add(box(10, 2.6, 2.6, 0x2f6fbf, 0, 1.75, 0));
    g.add(box(10.05, 1.0, 2.62, glass, 0, 2.3, 0));
    g.add(box(10.05, 0.5, 2.64, 0xf2f2f2, 0, 1.15, 0));
    [-3.4, 3.4].forEach((x) => [-1.2, 1.2].forEach((z) => wheel(x, z)));
    g.add(box(0.1, 0.8, 1.8, 0xfff2b0, 5.02, 1.0, 0));
  } else if (def.type === 'truck') {
    g.add(box(2.4, 2.4, 2.4, color, 3.8, 1.7, 0));
    g.add(box(0.1, 1.0, 2.1, glass, 5.02, 2.2, 0));
    g.add(box(6.6, 3.0, 2.6, 0xe6e6e6, -0.6, 2.0, 0));
    [-3, 0.2, 4.2].forEach((x) => [-1.15, 1.15].forEach((z) => wheel(x, z)));
  } else {
    g.add(box(4.4, 0.9, 1.9, color, 0, 0.9, 0));
    g.add(box(2.3, 0.85, 1.7, glass, -0.2, 1.7, 0));
    g.add(box(1.4, 0.06, 1.72, color, -0.2, 2.15, 0));
    [-1.4, 1.4].forEach((x) => [-0.85, 0.85].forEach((z) => wheel(x, z)));
    g.add(box(0.1, 0.25, 0.4, 0xfff2b0, 2.22, 1.0, 0.6));
    g.add(box(0.1, 0.25, 0.4, 0xfff2b0, 2.22, 1.0, -0.6));
  }
  return g;
}

function makePedestrian(def) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 1.1, 10), mat(col(def.color) ?? 0xe8602c));
  body.position.y = 1.15; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 12, 10), mat(0xf2c9a0));
  head.position.y = 1.95; head.castShadow = true; g.add(head);
  const l1 = box(0.22, 0.7, 0.22, 0x2a3a6a, 0, 0.35, 0.12);
  const l2 = box(0.22, 0.7, 0.22, 0x2a3a6a, 0, 0.35, -0.12);
  g.add(l1, l2);
  g.userData.legs = [l1, l2];
  g.scale.setScalar(1.6);
  return g;
}

// ---------- траектории ----------
function makePath(points) {
  const pts = points.map((p) => ({ t: p.t, x: p.x, z: p.z, ctrl: p.ctrl, ease: p.ease !== false }));
  const at = (t) => {
    if (t <= pts[0].t) return { x: pts[0].x, z: pts[0].z };
    const last = pts[pts.length - 1];
    if (t >= last.t) return { x: last.x, z: last.z };
    let i = 0;
    while (pts[i + 1].t < t) i++;
    const a = pts[i], b = pts[i + 1];
    let u = (t - a.t) / (b.t - a.t);
    if (b.ease) u = smooth(u);
    if (b.ctrl) {
      const v = 1 - u;
      return {
        x: v * v * a.x + 2 * v * u * b.ctrl[0] + u * u * b.x,
        z: v * v * a.z + 2 * v * u * b.ctrl[1] + u * u * b.z,
      };
    }
    return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u) };
  };
  // таблица курса: считаем по ходу движения, при остановке держим последний
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, step = 1 / 60;
  const table = [];
  let heading = null;
  for (let t = t0; t <= t1 + 0.5; t += step) {
    const p = at(t), q = at(t + 0.05);
    const dx = q.x - p.x, dz = q.z - p.z;
    if (dx * dx + dz * dz > 1e-7) {
      const h = Math.atan2(-dz, dx);
      heading = heading === null ? h : lerpAngle(heading, h, 0.12);
    }
    table.push(heading ?? 0);
  }
  if (heading === null) table.push(0);
  const headingAt = (t) => table[clamp(Math.round((t - t0) / step), 0, table.length - 1)];
  const speedAt = (t) => {
    const p = at(t), q = at(t + 0.1);
    return Math.hypot(q.x - p.x, q.z - p.z) / 0.1;
  };
  return { at, headingAt, speedAt };
}

// ---------- сцена ----------
export async function createEngine(canvas, overlay, scenario, size) {
  seed = 7;
  const { width, height } = size;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa9d8f2);
  scene.fog = new THREE.Fog(0xa9d8f2, 90, 220);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8fbf7a, 0.95));
  const sun = new THREE.DirectionalLight(0xfff3dd, 1.35);
  sun.position.set(30, 60, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 200 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const roads = scenario.scene.roads ?? ['x', 'z'];
  buildGround(scene, roads);
  buildScenery(scene, roads);
  (scenario.scene.crosswalks ?? []).forEach((z) => addCrosswalk(scene, z));
  (scenario.scene.signs ?? []).forEach((s) => scene.add(makeSign(s)));

  // объекты
  const actors = {};
  for (const o of scenario.objects) {
    const mesh = o.type === 'pedestrian' ? makePedestrian(o) : makeVehicle(o);
    scene.add(mesh);
    actors[o.id] = { def: o, mesh, path: makePath(o.path) };
  }

  // подсветка-кольцо
  const ringGeo = new THREE.RingGeometry(1.0, 1.25, 40);
  const rings = (scenario.highlights ?? []).map((h) => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: col(h.color) ?? 0xffd400, transparent: true, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    scene.add(m);
    return { h, m };
  });

  // подсказки-маршруты (полупрозрачная лента по земле)
  const ribbons = (scenario.routes ?? []).map((r) => {
    const g = new THREE.Group();
    for (let i = 0; i < r.points.length - 1; i++) {
      const [x1, z1] = r.points[i], [x2, z2] = r.points[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, 1.0), new THREE.MeshBasicMaterial({ color: col(r.color) ?? 0x7cff6b, transparent: true, opacity: 0.8 }));
      seg.position.set((x1 + x2) / 2, 0.36, (z1 + z2) / 2);
      seg.rotation.y = Math.atan2(-(z2 - z1), x2 - x1);
      g.add(seg);
    }
    scene.add(g);
    return { r, g };
  });

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.5, 400);
  const camKeys = scenario.camera;

  // --- оверлей ---
  overlay.innerHTML = '';
  const el = (cls, parent = overlay) => { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; };
  const markup = (s) => s.replace(/\[(g|r|y)\](.*?)\[\/\1\]/g, '<span class="c-$1">$2</span>');

  const tag = el('tag'); tag.textContent = scenario.tag ?? 'ПДД';
  const hooks = (scenario.hooks ?? []).map((h) => { const d = el('hook ' + (h.style ?? '')); d.innerHTML = markup(h.text); return { h, d }; });
  const labels = (scenario.labels ?? []).map((l) => { const d = el('label ' + (l.style ?? '')); d.innerHTML = markup(l.text); return { l, d }; });
  const captions = (scenario.voiceover ?? []).filter((v) => !v.noCaption).map((v) => { const d = el('caption'); d.innerHTML = markup(v.text); return { v, d }; });
  let card = null;
  if (scenario.card) {
    const d = el('card');
    d.innerHTML = `<div class="card-h">Вопрос из билета</div>
      <div class="card-q">${scenario.card.question}</div>
      ${scenario.card.answers.map((a, i) => `<div class="ans" data-i="${i}"><b>${i + 1}</b><span>${a}</span></div>`).join('')}`;
    card = { c: scenario.card, d, answers: [...d.querySelectorAll('.ans')] };
  }
  const cta = scenario.cta ? (() => { const d = el('cta'); d.innerHTML = `<div class="cta-t">${markup(scenario.cta.text)}</div><div class="cta-s">${scenario.cta.sub ?? ''}</div>`; return { c: scenario.cta, d }; })() : null;

  const vis = (d, on, fade = 0) => { d.style.opacity = on; d.style.display = on > 0.001 ? '' : 'none'; };
  const win = (t, t0, t1, f = 0.25) => clamp(Math.min((t - t0) / f, (t1 - t) / f), 0, 1);

  const tmp = new THREE.Vector3();
  const project = (v3) => {
    tmp.copy(v3).project(camera);
    return { x: (tmp.x * 0.5 + 0.5) * width, y: (-tmp.y * 0.5 + 0.5) * height, z: tmp.z };
  };

  function renderAt(t) {
    // объекты
    for (const a of Object.values(actors)) {
      const p = a.path.at(t);
      a.mesh.position.set(p.x, 0.25, p.z);
      a.mesh.rotation.y = a.path.headingAt(t);
      if (a.def.type === 'pedestrian') {
        const sp = a.path.speedAt(t);
        const k = Math.sin(t * 9) * 0.35 * clamp(sp, 0, 1);
        a.mesh.userData.legs[0].rotation.z = k; a.mesh.userData.legs[1].rotation.z = -k;
        a.mesh.rotation.y = a.path.headingAt(t) + Math.PI / 2 * 0; // курс уже по движению
        a.mesh.position.y = 0.25 + Math.abs(Math.sin(t * 9)) * 0.04 * clamp(sp, 0, 1);
      }
    }
    // камера
    let i = 0;
    while (i < camKeys.length - 2 && camKeys[i + 1].t <= t) i++;
    const a = camKeys[i], b = camKeys[Math.min(i + 1, camKeys.length - 1)];
    const u = b.t === a.t ? 1 : smooth(clamp((t - a.t) / (b.t - a.t), 0, 1));
    camera.position.set(lerp(a.pos[0], b.pos[0], u), lerp(a.pos[1], b.pos[1], u), lerp(a.pos[2], b.pos[2], u));
    camera.fov = lerp(a.fov ?? 50, b.fov ?? 50, u);
    camera.updateProjectionMatrix();
    camera.lookAt(lerp(a.look[0], b.look[0], u), lerp(a.look[1], b.look[1], u), lerp(a.look[2], b.look[2], u));
    camera.updateMatrixWorld();

    // подсветки
    for (const { h, m } of rings) {
      const on = win(t, h.t0, h.t1);
      m.visible = on > 0;
      const tgt = actors[h.target];
      if (tgt) m.position.set(tgt.mesh.position.x, 0.4, tgt.mesh.position.z);
      const pulse = 1 + Math.sin(t * 7) * 0.1;
      const sc = (h.size ?? 3) * pulse;
      m.scale.set(sc, sc, sc);
      m.material.opacity = on;
    }
    for (const { r, g } of ribbons) {
      const on = win(t, r.t0, r.t1);
      g.visible = on > 0;
      g.children.forEach((c) => (c.material.opacity = 0.85 * on));
    }
    renderer.render(scene, camera);

    // оверлей
    for (const { h, d } of hooks) vis(d, win(t, h.t0, h.t1));
    for (const { v, d } of captions) vis(d, win(t, v.t0, v.t1, 0.12));
    for (const { l, d } of labels) {
      const on = win(t, l.t0, l.t1);
      vis(d, on);
      if (on > 0) {
        let pos;
        if (typeof l.target === 'string') {
          const m = actors[l.target].mesh.position;
          pos = new THREE.Vector3(m.x, (l.height ?? 3.6), m.z);
        } else pos = new THREE.Vector3(l.target[0], l.target[1], l.target[2]);
        const s = project(pos);
        // не даём подписи уйти за край кадра
        const half = d.offsetWidth / 2 + width * 0.02;
        const x = clamp(s.x, half, width - half);
        d.style.transform = `translate(${x}px, ${s.y}px) translate(-50%, -100%) scale(${0.85 + 0.15 * on})`;
      }
    }
    if (card) {
      const on = Math.max(...card.c.windows.map(([a, b]) => win(t, a, b, 0.35)));
      vis(card.d, on);
      card.d.style.transform = `translateY(${(1 - on) * -30}px)`;
      const rev = t >= card.c.reveal;
      card.answers.forEach((n, k) => {
        n.classList.toggle('ok', rev && k === card.c.correct);
        n.classList.toggle('dim', rev && k !== card.c.correct);
      });
    }
    if (cta) vis(cta.d, win(t, cta.c.t0, cta.c.t1, 0.4));
  }

  return { renderAt, duration: scenario.duration };
}
