// Транспорт: процедурные модели «под реальные» (седан, автобус, грузовик) с анимацией колёс,
// стоп-сигналами, поворотниками и приседанием кузова. Ось «вперёд» модели — +x, левый борт — −z.
import * as THREE from 'three';
import { simplifySubtree } from './assets.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const shadowed = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
export const CAR_COLORS = { blue: 0x1f4fa8, red: 0xb5161b, white: 0xf1f1ef, black: 0x15171a, yellow: 0xe8b008, green: 0x1e7a46, grey: 0x7d838b, silver: 0xb7bcc2 };
const col = (c) => (typeof c === 'string' ? Number(c) : c);

const paint = (color) => new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.2 });
const M = {
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1116, metalness: 0.1, roughness: 0.04, envMapIntensity: 1.8, clearcoat: 1, side: THREE.DoubleSide }),
  trim: new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.75 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.9, roughness: 0.28 }),
  head: new THREE.MeshStandardMaterial({ color: 0xf4f6f8, emissive: 0xfff6e0, emissiveIntensity: 0.4, roughness: 0.1, metalness: 0.3 }),
  plate: null,
};

function plateTexture() {
  if (M.plate) return M.plate;
  const c = document.createElement('canvas'); c.width = 520; c.height = 112;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 520, 112);
  g.strokeStyle = '#111'; g.lineWidth = 6; g.strokeRect(4, 4, 512, 104);
  g.beginPath(); g.moveTo(400, 4); g.lineTo(400, 108); g.stroke();
  g.fillStyle = '#111'; g.font = 'bold 74px DejaVu Sans, sans-serif'; g.textBaseline = 'middle';
  g.fillText('А777АА', 24, 60);
  g.font = 'bold 50px DejaVu Sans, sans-serif'; g.fillText('77', 425, 46);
  g.font = 'bold 22px DejaVu Sans, sans-serif'; g.fillText('RUS', 432, 90);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  M.plate = new THREE.MeshStandardMaterial({ map: t, roughness: 0.4 });
  return M.plate;
}

/** Колесо: шина с округлым профилем + диск со спицами (чтобы было видно вращение). Ось — z. */
function wheel(radius = 0.33, width = 0.22) {
  const g = new THREE.Group();
  const pts = [];
  const r0 = radius * 0.68;
  for (let i = 0; i <= 12; i++) {
    const a = -Math.PI / 2 + (i / 12) * Math.PI;
    pts.push(new THREE.Vector2(r0 + (radius - r0) * (0.55 + 0.45 * Math.cos(a)), (width / 2) * Math.sin(a)));
  }
  const tire = shadowed(new THREE.Mesh(new THREE.LatheGeometry(pts, 36), M.tire));
  tire.rotation.x = Math.PI / 2;
  g.add(tire);
  const disc = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(r0 * 0.98, r0 * 0.98, width * 0.6, 28), M.rim));
  disc.rotation.x = Math.PI / 2; g.add(disc);
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(r0 * 1.7, r0 * 0.22, 0.03), M.trim);
    spoke.rotation.z = (i / 5) * Math.PI;
    spoke.position.z = width * 0.31;
    g.add(spoke);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 0.22, r0 * 0.22, width * 0.66, 16), M.chrome);
  hub.rotation.x = Math.PI / 2; g.add(hub);
  return g;
}

/** Профиль кузова седана (вид сбоку) с вырезами под колёсные арки. */
function sedanProfile(wb = 1.36, rArch = 0.43) {
  const s = new THREE.Shape();
  s.moveTo(-2.12, 0.36);
  s.lineTo(-2.26, 0.5); s.lineTo(-2.26, 0.86); s.lineTo(-2.1, 0.98);
  s.lineTo(-1.38, 1.0);                      // крышка багажника
  s.quadraticCurveTo(-1.0, 1.25, -0.72, 1.4);   // заднее стекло
  s.quadraticCurveTo(-0.15, 1.47, 0.42, 1.43);  // крыша
  s.quadraticCurveTo(0.8, 1.22, 1.18, 1.0);     // лобовое
  s.quadraticCurveTo(1.7, 0.95, 2.12, 0.86);    // капот
  s.quadraticCurveTo(2.3, 0.78, 2.28, 0.6);
  s.lineTo(2.24, 0.42); s.lineTo(2.1, 0.33);
  s.lineTo(wb + rArch, 0.33);
  s.absarc(wb, 0.36, rArch, 0, Math.PI, false);
  s.lineTo(-wb + rArch, 0.33);
  s.absarc(-wb, 0.36, rArch, 0, Math.PI, false);
  s.lineTo(-2.12, 0.36);
  return s;
}

function glassPanel(points, z) {
  const sh = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), M.glass);
  m.position.z = z;
  return m;
}

/** Наклонное стекло по двум точкам профиля (x, y) шириной w; смещено наружу на off. */
function slopeGlass([x1, y1], [x2, y2], w, off = 0.075) {
  let nx = -(y2 - y1), ny = x2 - x1;
  const l = Math.hypot(nx, ny); nx /= l; ny /= l;
  if (ny < 0) { nx = -nx; ny = -ny; }          // нормаль наружу (вверх)
  const ax = x1 + nx * off, ay = y1 + ny * off, bx = x2 + nx * off, by = y2 + ny * off, h = w / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([ax, ay, -h, bx, by, -h, bx, by, h, ax, ay, h], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return new THREE.Mesh(g, M.glass);
}

function lights(g, { front, rear, y, yr = y, z, w = 0.36, h = 0.14, blink }) {
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0606, emissive: 0xff1a0a, emissiveIntensity: 0.6, roughness: 0.2 });
  for (const sz of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.08, h, w), M.head); hl.position.set(front, y, sz * z); g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.06, h, w), tail); tl.position.set(rear, yr, sz * z); g.add(tl);
  }
  // поворотники: углы спереди и сзади + повторители на крыльях
  const ud = { left: [], right: [] };
  for (const [side, sz] of [['left', -1], ['right', 1]]) {
    for (const [x, yy] of [[front - 0.02, y - 0.12], [rear + 0.02, yr - 0.12]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.18), new THREE.MeshStandardMaterial({ color: 0xff8a00, emissive: 0xff8a00, emissiveIntensity: 5 }));
      b.position.set(x, yy, sz * (z + w / 2 - 0.09)); b.visible = false; g.add(b); ud[side].push(b);
    }
    if (blink) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.02), new THREE.MeshStandardMaterial({ color: 0xff8a00, emissive: 0xff8a00, emissiveIntensity: 5 }));
      r.position.set(blink[0], blink[1], sz * blink[2]); r.visible = false; g.add(r); ud[side].push(r);
    }
  }
  return { tail, blink: ud };
}

function plates(g, front, rear, y, yr = y) {
  const pm = plateTexture();
  const f = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.112), pm); f.position.set(front, y, 0); f.rotation.y = Math.PI / 2; g.add(f);
  const r = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.112), pm); r.position.set(rear, yr, 0); r.rotation.y = -Math.PI / 2; g.add(r);
}

// ---------- седан ----------
function sedan(color) {
  const root = new THREE.Group();
  const body = new THREE.Group();   // всё, что качается на подвеске
  root.add(body);
  const width = 1.62;
  const geo = new THREE.ExtrudeGeometry(sedanProfile(), { depth: width, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.08, bevelSegments: 5, curveSegments: 18 });
  geo.translate(0, 0, -width / 2);
  geo.computeVertexNormals();
  body.add(shadowed(new THREE.Mesh(geo, paint(color))));
  const hw = width / 2 + 0.092;
  // боковые стёкла (обе стороны) + стойки
  const side = [[-1.28, 1.02], [-0.74, 1.36], [0.4, 1.385], [1.06, 1.02]];
  body.add(glassPanel(side, hw), glassPanel(side, -hw));
  for (const sz of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.4, 0.01), M.trim); b.position.set(-0.12, 1.2, sz * (hw + 0.002)); body.add(b);
    const mirror = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.2), paint(color))); mirror.position.set(1.0, 1.08, sz * (hw + 0.1)); body.add(mirror);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.1, 0.02), M.trim); sill.position.set(0, 0.4, sz * (hw - 0.005)); body.add(sill);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.02), M.chrome);
    handle.position.set(0.25, 0.95, sz * (hw + 0.005)); body.add(handle);
    const h2 = handle.clone(); h2.position.x = -0.55; body.add(h2);
  }
  // лобовое и заднее стёкла по линиям профиля
  body.add(slopeGlass([1.18, 1.0], [0.44, 1.42], 1.5));
  body.add(slopeGlass([-1.36, 1.0], [-0.74, 1.39], 1.45));
  // решётка, бамперы
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.9), M.trim); grille.position.set(2.31, 0.66, 0); body.add(grille);
  for (const x of [2.3, -2.3]) { const bp = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 1.66), M.trim); bp.position.set(x, 0.45, 0); body.add(bp); }
  const L = lights(body, { front: 2.3, rear: -2.3, y: 0.72, yr: 0.86, z: 0.62, blink: [1.75, 0.82, hw] });
  plates(body, 2.36, -2.36, 0.5, 0.62);
  const wheels = [];
  for (const [x, front] of [[1.36, true], [-1.36, false]]) for (const sz of [-1, 1]) {
    const w = wheel(); const pivot = new THREE.Group(); pivot.position.set(x, 0.33, sz * 0.74); pivot.add(w);
    if (sz < 0) w.rotation.y = Math.PI;   // диск наружу
    root.add(pivot); wheels.push({ pivot, spin: w, front, side: sz, flip: sz < 0 });
  }
  root.userData = { body, wheels, radius: 0.33, tail: L.tail, blink: L.blink, length: 4.6 };
  return root;
}

// ---------- автобус (городской, ~12 м) ----------
function bus(color = 0xf2f2f0) {
  const root = new THREE.Group(); const body = new THREE.Group(); root.add(body);
  const len = 11.6, h = 2.75, w = 2.5;
  const s = new THREE.Shape();
  const r = 0.35, x0 = -len / 2, x1 = len / 2, y0 = 0.42, y1 = y0 + h;
  s.moveTo(x0 + r, y0); s.lineTo(x1 - 0.2, y0); s.quadraticCurveTo(x1, y0, x1, y0 + 0.3);
  s.lineTo(x1, y1 - 0.5); s.quadraticCurveTo(x1, y1, x1 - 0.5, y1); s.lineTo(x0 + r, y1); s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const geo = new THREE.ExtrudeGeometry(s, { depth: w - 0.12, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 4, curveSegments: 12 });
  geo.translate(0, 0, -(w - 0.12) / 2);
  body.add(shadowed(new THREE.Mesh(geo, paint(color))));
  const stripe = paint(0x1f4fa8);
  const hw = w / 2 + 0.005;
  for (const sz of [-1, 1]) {
    // ленточное остекление, двери, полоса
    const win = new THREE.Mesh(new THREE.PlaneGeometry(len - 2.0, 1.15), M.glass);
    win.position.set(-0.6, y0 + 1.95, sz * hw); if (sz < 0) win.rotation.y = Math.PI; body.add(win);
    const band = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.4, 0.25), stripe);
    band.position.set(0, y0 + 1.15, sz * (hw + 0.001)); if (sz < 0) band.rotation.y = Math.PI; body.add(band);
    if (sz > 0) for (const dx of [len / 2 - 1.3, -0.2, -len / 2 + 1.6]) {
      const door = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 2.3), M.glass); door.position.set(dx, y0 + 1.3, hw + 0.004); body.add(door);
      const frame = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 2.3), M.trim); frame.position.set(dx, y0 + 1.3, hw + 0.006); body.add(frame);
    }
  }
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.3, 1.7), M.glass);   // ширина по z, высота по y
  ws.rotation.y = Math.PI / 2; ws.position.set(x1 + 0.065, y0 + 1.75, 0); body.add(ws);
  const disp = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.28, 1.6), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffa31a, emissiveIntensity: 0.9 }));
  disp.position.set(x1 + 0.05, y1 - 0.3, 0); body.add(disp);
  const rearW = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.5, 1.0), M.glass); rearW.rotation.y = -Math.PI / 2; rearW.position.set(x0 - 0.065, y0 + 2.0, 0); body.add(rearW);
  body.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.3, 1.6), paint(color))).translateX(-1).translateY(y1 + 0.15));
  const L = lights(body, { front: x1 + 0.07, rear: x0 - 0.07, y: y0 + 0.45, z: 0.95, w: 0.3, h: 0.16, blink: [x1 - 0.6, y0 + 0.75, hw] });
  plates(body, x1 + 0.08, x0 - 0.08, y0 + 0.25);
  const wheels = [];
  for (const [x, front] of [[x1 - 2.6, true], [x0 + 3.2, false]]) for (const sz of [-1, 1]) {
    const wh = wheel(0.5, 0.3); const pivot = new THREE.Group(); pivot.position.set(x, 0.5, sz * 1.05); pivot.add(wh);
    if (sz < 0) wh.rotation.y = Math.PI;
    root.add(pivot); wheels.push({ pivot, spin: wh, front, side: sz, flip: sz < 0 });
  }
  root.userData = { body, wheels, radius: 0.5, tail: L.tail, blink: L.blink, length: len };
  return root;
}

// ---------- грузовик (кабина + фургон) ----------
function truck(color) {
  const root = new THREE.Group(); const body = new THREE.Group(); root.add(body);
  const cab = new THREE.Shape();
  cab.moveTo(0, 0.55); cab.lineTo(2.1, 0.55); cab.lineTo(2.2, 1.5); cab.quadraticCurveTo(2.15, 2.75, 1.7, 2.95); cab.lineTo(0.15, 2.95); cab.lineTo(0, 2.8); cab.lineTo(0, 0.55);
  const cg = new THREE.ExtrudeGeometry(cab, { depth: 2.3, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 3 });
  cg.translate(2.6, 0, -1.15);
  body.add(shadowed(new THREE.Mesh(cg, paint(color))));
  body.add(slopeGlass([4.79, 1.75], [4.5, 2.72], 2.05, 0.07));
  for (const sz of [-1, 1]) { const sw = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.75), M.glass); sw.position.set(4.0, 2.3, sz * 1.215); if (sz < 0) sw.rotation.y = Math.PI; body.add(sw); }
  const box = shadowed(new THREE.Mesh(new THREE.BoxGeometry(6.6, 2.8, 2.5), new THREE.MeshStandardMaterial({ color: 0xe9e9e6, roughness: 0.55, metalness: 0.2 })));
  box.position.set(-0.85, 2.1, 0); body.add(box);
  body.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.25, 1.0), M.trim)).translateX(0.3).translateY(0.6));
  const L = lights(body, { front: 4.83, rear: -4.17, y: 0.85, yr: 0.8, z: 0.9, w: 0.3, blink: [3.6, 1.0, 1.21] });
  plates(body, 4.85, -4.2, 0.62, 0.62);
  const wheels = [];
  for (const [x, front] of [[3.9, true], [-1.6, false], [-2.95, false]]) for (const sz of [-1, 1]) {
    const wh = wheel(0.5, 0.3); const pivot = new THREE.Group(); pivot.position.set(x, 0.5, sz * 1.0); pivot.add(wh);
    if (sz < 0) wh.rotation.y = Math.PI;
    root.add(pivot); wheels.push({ pivot, spin: wh, front, side: sz, flip: sz < 0 });
  }
  root.userData = { body, wheels, radius: 0.5, tail: L.tail, blink: L.blink, length: 9.4 };
  return root;
}

export function makeVehicle(def) {
  const color = CAR_COLORS[def.color] ?? col(def.color) ?? CAR_COLORS.blue;
  if (def.type === 'bus') return bus(def.color ? color : undefined);
  if (def.type === 'truck') return truck(color);
  return sedan(color);
}

/**
 * Анимация машины в момент t: вращение и поворот колёс, приседание кузова, стоп-сигналы, поворотники.
 * kin: { dist, speed, accel, yawRate } — из траектории.
 */
export function animateVehicle(v, def, t, kin) {
  const ud = v.userData;
  if (!ud.wheels) return;
  const spin = -kin.dist / ud.radius;
  const steer = THREE.MathUtils.clamp(kin.yawRate * 0.45, -0.5, 0.5);
  for (const w of ud.wheels) {
    w.spin.rotation.z = spin * (w.flip ? -1 : 1);
    w.pivot.rotation.y = w.front ? steer : 0;
  }
  // кузов: клюёт носом при торможении, приседает назад при разгоне, кренится в повороте
  ud.body.rotation.z = THREE.MathUtils.clamp(kin.accel * 0.006, -0.025, 0.025);
  ud.body.rotation.x = THREE.MathUtils.clamp(-kin.yawRate * kin.speed * 0.004, -0.03, 0.03);
  // стоп-сигналы: при торможении и на месте
  const braking = kin.accel < -0.3 || kin.speed < 0.3;
  ud.tail.emissiveIntensity = braking ? 5 : 0.6;
  if (def.blinker && ud.blink) {
    const bl = def.blinker;
    const on = t >= bl.t0 && t <= bl.t1 && Math.floor(t * 2.6) % 2 === 0;
    for (const side of ['left', 'right']) ud.blink[side].forEach((m) => (m.visible = on && side === bl.side));
  }
}

// ---------- свои модели (glTF/GLB) ----------
const AXES = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] };

/**
 * Машина из готовой модели: разворот носом в +x, масштаб по длине, колёса — на отдельные оси
 * (вращение и поворот), поворотники по углам, стоп-сигналы — материалы по шаблону имён.
 */
/** Сливает меши поддерева в один меш на материал (в координатах узла space), пропуская skip-поддеревья. */
function mergeByMaterial(node, space, skip = []) {
  node.updateMatrixWorld(true);
  const inv = space.matrixWorld.clone().invert();
  const groups = new Map();
  const meshes = [];
  node.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || skip.some((w) => w === o || isAncestor(w, o))) return;
    if (Array.isArray(o.material) || o.geometry.morphAttributes?.position) return;
    meshes.push(o);
  });
  for (const m of meshes) {
    let g = m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const key = m.material.uuid;
    if (!groups.has(key)) groups.set(key, { material: m.material, geos: [] });
    groups.get(key).geos.push(g);
  }
  if (meshes.length < 2) return;
  for (const m of meshes) m.removeFromParent();
  for (const { material, geos } of groups.values()) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = material.name ?? '';
    // меш создан в координатах space: вешаем на space и обнуляем его собственный сдвиг
    space.add(mesh);
  }
}

/**
 * Подготовка модели один раз на файл (копии делят геометрию): упрощение тяжёлых веток
 * (cfg.simplify: { "шаблон имени": доля }), скрытие лишнего (cfg.hide), простое стекло вместо преломления.
 */
export async function prepareVehicleModel(gltf, cfg) {
  if (gltf.userData.prepared) return;
  gltf.userData.prepared = true;
  const root = gltf.scene;
  if (cfg.hide) { const re = new RegExp(cfg.hide, 'i'); const drop = []; root.traverse((o) => { if (o !== root && re.test(o.name)) drop.push(o); }); drop.forEach((o) => o.removeFromParent()); }
  for (const [pattern, ratio] of Object.entries(cfg.simplify ?? {})) {
    const re = new RegExp(pattern, 'i'); const hits = [];
    root.traverse((o) => { if (re.test(o.name)) hits.push(o); });
    for (const h of hits) await simplifySubtree(h, ratio);
  }
  // сотни мелких деталей → по одному объекту на материал (кузов) и на колесо: у программной
  // видеокарты каждый вызов отрисовки дорогой, а у моделей с Sketchfab их по 500–700 на машину
  const wheelRe = new RegExp(cfg.wheels ?? 'wheel|tire|tyre|колес', 'i');
  root.updateMatrixWorld(true);
  const wheels = [];
  root.traverse((o) => { if (o !== root && wheelRe.test(o.name) && !wheels.some((w) => isAncestor(w, o))) wheels.push(o); });
  for (const w of wheels) mergeByMaterial(w, w);
  mergeByMaterial(root, root, wheels);
  // «честное» преломление (transmission) требует лишнего прохода рендера на каждый кадр — заменяем тонировкой
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [o.material].flat()) if (m.transmission > 0) { m.transmission = 0; m.transparent = true; m.opacity = cfg.glassOpacity ?? 0.55; m.depthWrite = false; m.roughness = Math.min(m.roughness, 0.08); }
  });
}

export function makeVehicleFromModel(def, cfg, gltf) {
  const src = gltf.scene.clone(true);
  const paintRe = cfg.paint ? new RegExp(cfg.paint, 'i') : null;
  const paintColor = def.color !== undefined ? (CAR_COLORS[def.color] ?? col(def.color)) : null;
  src.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    // перекраска кузова под цвет из сценария: одна модель играет разные машины
    if (paintRe && paintColor !== null && paintRe.test(o.material.name ?? '')) o.material.color.setHex(paintColor);
    o.castShadow = true; o.receiveShadow = true;
  });
  src.updateMatrixWorld(true);
  const wheelRe = new RegExp(cfg.wheels ?? 'wheel|tire|tyre|колес', 'i');
  const wheelNodes = [];
  src.traverse((o) => { if (o !== src && wheelRe.test(o.name) && !wheelNodes.some((w) => o.parent && isAncestor(w, o))) wheelNodes.push(o); });
  const center = (o) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());

  // направление «вперёд» в координатах модели
  let fwd = AXES[cfg.forward];
  if (!fwd) {
    const fr = wheelNodes.filter((w) => /front|fl\b|fr\b|перед/i.test(w.name)), bk = wheelNodes.filter((w) => /back|rear|rl\b|rr\b|зад/i.test(w.name));
    if (fr.length && bk.length) {
      const avg = (arr) => arr.reduce((a, w) => a.add(center(w)), new THREE.Vector3()).divideScalar(arr.length);
      const d = avg(fr).sub(avg(bk));
      fwd = Math.abs(d.x) > Math.abs(d.z) ? [Math.sign(d.x), 0] : [0, Math.sign(d.z)];
    } else {
      const s = new THREE.Box3().setFromObject(src).getSize(new THREE.Vector3());
      fwd = s.x >= s.z ? [1, 0] : [0, 1];   // нос не определить — длинная ось, направление задайте forward в models.json
    }
  }
  const holder = new THREE.Group();
  holder.rotation.y = Math.atan2(fwd[1], fwd[0]);
  holder.add(src);
  holder.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  holder.scale.setScalar((cfg.length ?? size.x) / size.x);
  holder.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(holder);
  const c = box.getCenter(new THREE.Vector3());
  holder.position.set(-c.x, -box.min.y, -c.z);

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.add(holder);
  root.updateMatrixWorld(true);

  // колёса: переносим на свои оси, чтобы они не качались вместе с кузовом и крутились вокруг центра
  const wheels = [];
  let radius = 0.33;
  for (const w of wheelNodes) {
    const wb = new THREE.Box3().setFromObject(w);
    const wc = wb.getCenter(new THREE.Vector3());
    radius = (wb.max.y - wb.min.y) / 2 || radius;
    const pivot = new THREE.Group(); pivot.position.copy(wc); root.add(pivot);
    const spin = new THREE.Group(); pivot.add(spin);
    root.updateMatrixWorld(true);
    spin.attach(w);
    wheels.push({ pivot, spin, front: wc.x > 0, side: Math.sign(wc.z) || 1, flip: false });
  }
  // стоп-сигналы: материалы по имени
  const lightRe = new RegExp(cfg.lights ?? 'tail|brake|stop|rear.?light', 'i');
  const tails = [];
  src.traverse((o) => { if (o.isMesh && lightRe.test(o.material.name ?? '')) { o.material.emissive = new THREE.Color(0xff1a0a); tails.push(o.material); } });
  const tail = { set emissiveIntensity(v) { tails.forEach((m) => (m.emissiveIntensity = v)); } };
  // поворотники: светящиеся вставки поверх родных оранжевых стёкол модели (cfg.blinkers — шаблон материала),
  // разбитые на 4 угла; если таких материалов нет — по углам кузова
  const blink = { left: [], right: [] };
  // светящаяся пластина на внешней поверхности фонаря (внутри корпуса её закрыло бы стекло)
  const lampAt = (b, side, front, scale = 1) => {
    const size = b.getSize(new THREE.Vector3());
    const c = b.getCenter(new THREE.Vector3());
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.02, Math.max(0.04, size.y * scale), Math.max(0.06, size.z * scale)),
      new THREE.MeshStandardMaterial({ color: 0xff8a00, emissive: 0xff8a00, emissiveIntensity: 6 }));
    m.position.set(front ? b.max.x + 0.012 : b.min.x - 0.012, c.y, c.z);
    m.visible = false;
    body.add(m);
    blink[side].push(m);
  };
  const corners = cfg.blinkers ? cornerBoxes(root, new RegExp(cfg.blinkers, 'i')) : new Map();
  // где своих оранжевых стёкол нет (часто — сзади), мигаем частью стоп-фонаря
  const tailCorners = cfg.lights ? cornerBoxes(root, new RegExp(cfg.lights, 'i')) : new Map();
  for (const key of ['fleft', 'fright', 'rleft', 'rright']) {
    if (corners.has(key)) lampAt(corners.get(key), key.slice(1), key[0] === 'f');
    else if (tailCorners.has(key)) lampAt(tailCorners.get(key), key.slice(1), key[0] === 'f', 0.45);
  }
  if (!blink.left.length || !blink.right.length) {
  const lamp = () => new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, 0.16), new THREE.MeshStandardMaterial({ color: 0xff8a00, emissive: 0xff8a00, emissiveIntensity: 5 }));
  const L = (cfg.length ?? size.x) / 2, Wd = box.max.z, H = box.max.y;
  for (const [side, sz] of [['left', -1], ['right', 1]]) for (const x of [L - 0.1, -L + 0.1]) {
    const b = lamp(); b.position.set(x, H * 0.42, sz * (Wd * 0.8)); b.visible = false; body.add(b); blink[side].push(b);
  }
  }
  root.userData = { body, wheels, radius, tail, blink, length: cfg.length ?? size.x };
  return root;
}
/** Габариты вершин мешей с материалом по шаблону re, разбитые по углам: ключи 'fleft', 'rright' и т. п. */
function cornerBoxes(root, re) {
  const clusters = new Map();
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  root.traverse((o) => {
    if (!o.isMesh || !re.test(o.material.name ?? '')) return;
    const pos = o.geometry.attributes.position;
    const toRoot = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
      const key = `${v.x > 0 ? 'f' : 'r'}${v.z < 0 ? 'left' : 'right'}`;
      if (!clusters.has(key)) clusters.set(key, new THREE.Box3());
      clusters.get(key).expandByPoint(v);
    }
  });
  return clusters;
}
function isAncestor(a, o) { for (let p = o.parent; p; p = p.parent) if (p === a) return true; return false; }
