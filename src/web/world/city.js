// Город: дороги, тротуары, бордюры, газоны, разметка, панельные дома, деревья, фонари, мелочи.
// Единицы — метры. Дороги: ось x и/или z через (0, 0). Движение правостороннее.
import * as THREE from 'three';
import { Tree, LeafType } from '@dgreenheck/ez-tree';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pbr, uvInMeters, boxUvInMeters, loadGltf, polyHavenModel } from './assets.js';

export const W = 8;            // проезжая часть (2 полосы по 4 м)
export const CURB = 0.25;      // бордюр
export const SIDEWALK = 3.5;   // тротуар
export const KERB_H = 0.15;    // высота тротуара над дорогой
const FAR = 160;               // длина дорог от центра
const EDGE = W / 2 + CURB + SIDEWALK;   // внешний край тротуара

let seed = 7;
export const reseed = (s = 7) => { seed = s; };
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const shadowed = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

// ---------- материалы (создаются один раз на сцену) ----------
// Стиль "clean" (по умолчанию) — чистая стилизованная картинка: ровный тёмный асфальт, красная плитка,
// яркий газон, светлые дома, мультяшные деревья. "real" — фотореализм (текстуры Poly Haven, EZ-Tree).
function canvasTex(px, draw, metersPerTile) {
  const c = document.createElement('canvas'); c.width = c.height = px;
  draw(c.getContext('2d'), px);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / metersPerTile, 1 / metersPerTile);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function makeCleanMaterials() {
  // плитка тротуара: кирпичики 25×12,5 см вперевязку, мортира светлая (тайл 2×2 м)
  const bricks = canvasTex(512, (g, n) => {
    g.fillStyle = '#b39c90'; g.fillRect(0, 0, n, n);
    const bw = n / 8, bh = n / 16;
    for (let r = 0; r < 16; r++) for (let c = -1; c < 8; c++) {
      const x = c * bw + (r % 2 ? bw / 2 : 0), l = 34 + rnd() * 12, h = 6 + rnd() * 6;
      g.fillStyle = `hsl(${h}, ${36 + rnd() * 10}%, ${l}%)`;
      g.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
    }
  }, 2);
  // асфальт: ровный, с едва заметным зерном (тайл 4×4 м)
  const asphalt = canvasTex(256, (g, n) => {
    g.fillStyle = '#3d3f43'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 2600; i++) { const v = 52 + rnd() * 18; g.fillStyle = `rgba(${v},${v},${v + 3},0.35)`; g.fillRect(rnd() * n, rnd() * n, 2, 2); }
  }, 4);
  const grass = canvasTex(256, (g, n) => {
    g.fillStyle = '#5cc23d'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 900; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(80,170,50,0.25)' : 'rgba(120,210,80,0.25)'; g.beginPath(); g.arc(rnd() * n, rnd() * n, 3 + rnd() * 8, 0, 7); g.fill(); }
  }, 6);
  const matte = (c, r = 0.95) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  return {
    clean: true,
    asphalt: new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.92 }),
    paving: new THREE.MeshStandardMaterial({ map: bricks, roughness: 0.9 }),
    curb: matte(0xd4d4d0, 0.8),
    grass: new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }),
    marking: new THREE.MeshStandardMaterial({ color: 0xf5f5f2, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    markingYellow: new THREE.MeshStandardMaterial({ color: 0xf0bf00, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    plaster: [0xeedcb2, 0xe6d2a4, 0xf2e6c8, 0xe9d7b0].map((c) => matte(c, 0.9)),
    brick: matte(0xe6d2a4, 0.9),
    concrete: matte(0xefece4, 0.9),
    roof: matte(0x8a8d92),
    frame: matte(0xffffff, 0.6),
    glass: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, metalness: 0.1, envMapIntensity: 1.2 }),
    balcony: matte(0xf3efe6, 0.85),
    metal: new THREE.MeshStandardMaterial({ color: 0x8c9096, roughness: 0.5, metalness: 0.5 }),
    galvanized: new THREE.MeshStandardMaterial({ color: 0xa9adb2, roughness: 0.35, metalness: 0.85 }),
  };
}
function makeMaterials() {
  return {
    asphalt: pbr('asphalt_02', { size: 7, color: 0xb8b8b8 }),
    paving: pbr('square_brick_paving', { size: 2.5, color: 0xc9c7c2 }),
    curb: pbr('brushed_concrete', { size: 1.5, color: 0xe6e6e6 }),
    grass: pbr('sparse_grass', { size: 3, color: 0x93c45e }),
    marking: new THREE.MeshStandardMaterial({ color: 0xcfcfc9, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    markingYellow: new THREE.MeshStandardMaterial({ color: 0xf0bf00, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    plaster: [0xf2e6c9, 0xe9ecef, 0xf0d9c2, 0xdde6ea, 0xefe7d6].map((c) => pbr('grey_plaster', { size: 4, color: c })),
    brick: pbr('brick_4', { size: 2.2, color: 0xe8d0c0 }),
    concrete: pbr('brushed_concrete', { size: 3, color: 0xcfcfcf }),
    roof: new THREE.MeshStandardMaterial({ color: 0x5b5d61, roughness: 0.95 }),
    frame: new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0.2, envMapIntensity: 1.6 }),
    balcony: new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.85 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.45, metalness: 0.7 }),
    galvanized: new THREE.MeshStandardMaterial({ color: 0xa9adb2, roughness: 0.35, metalness: 0.85 }),
  };
}

// ---------- инстансинг: тысячи окон и балконов одним вызовом отрисовки ----------
class Instances {
  constructor() { this.items = new Map(); }
  add(key, geo, mat, matrix, color) {
    if (!this.items.has(key)) this.items.set(key, { geo, mat, list: [] });
    this.items.get(key).list.push({ matrix: matrix.clone(), color });
  }
  flush(scene) {
    for (const { geo, mat, list } of this.items.values()) {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((it, i) => { im.setMatrixAt(i, it.matrix); if (it.color !== undefined) im.setColorAt(i, new THREE.Color(it.color)); });
      im.castShadow = true; im.receiveShadow = true;
      scene.add(im);
    }
  }
}

// ---------- дороги ----------
function strip(mat, x, z, lenX, lenZ, y) {
  const g = uvInMeters(new THREE.PlaneGeometry(lenX, lenZ).rotateX(-Math.PI / 2).translate(x, y, z));
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}
function slab(mat, cx, cz, lenX, lenZ, h, y0 = 0) {
  const g = boxUvInMeters(new THREE.BoxGeometry(lenX, h, lenZ).translate(cx, y0 + h / 2, cz));
  return shadowed(new THREE.Mesh(g, mat));
}

/** Тротуар с бордюром вдоль отрезка дороги. axis — вдоль какой оси дорога; side — ±1; [a, b] — диапазон вдоль оси. */
function sidewalk(scene, M, axis, side, a, b) {
  const len = b - a, mid = (a + b) / 2;
  const curbC = side * (W / 2 + CURB / 2), walkC = side * (W / 2 + CURB + SIDEWALK / 2);
  if (axis === 'x') {
    scene.add(slab(M.curb, mid, curbC, len, CURB, KERB_H + 0.03));
    scene.add(slab(M.paving, mid, walkC, len, SIDEWALK, KERB_H));
  } else {
    scene.add(slab(M.curb, curbC, mid, CURB, len, KERB_H + 0.03));
    scene.add(slab(M.paving, walkC, mid, SIDEWALK, len, KERB_H));
  }
}

function markings(scene, M, roads, crosswalks) {
  const zebraDefault = M.clean ? 'white' : 'yellow';
  const inst = new Instances();
  const m4 = new THREE.Matrix4();
  const dash = new THREE.BoxGeometry(1, 0.012, 1);
  const hasX = roads.includes('x'), hasZ = roads.includes('z');
  const cross = hasX && hasZ;
  const cwAt = (axis) => crosswalks.filter((c) => (typeof c === 'number' ? 'z' : c.road) === axis).map((c) => (typeof c === 'number' ? c : c.at));
  const blocked = (axis, s) => {
    if (cross && Math.abs(s) < W / 2 + (crosswalks.length ? 9 : 1.2)) return true;   // центр перекрёстка и зебры
    return cwAt(axis).some((c) => Math.abs(s - c) < 2.6);
  };
  const put = (x, z, sx, sz, yellow = false) => { m4.makeScale(sx, 1, sz).setPosition(x, 0.006, z); inst.add(yellow ? 'markY' : 'mark', dash, yellow ? M.markingYellow : M.marking, m4); };
  // осевая — пунктир 3 м через 6 м
  for (const axis of ['x', 'z']) {
    if (!roads.includes(axis)) continue;
    for (let s = -FAR; s < FAR; s += 6) {
      const c = s + 1.5;
      if (blocked(axis, c)) continue;
      axis === 'x' ? put(c, 0, 3, 0.15) : put(0, c, 0.15, 3);
    }
  }
  // стоп-линии (только на перекрёстке)
  if (cross) {
    const so = crosswalks.length ? 9.6 : W / 2 + 0.8;
    put(2, so, 4, 0.4); put(-2, -so, 4, 0.4); put(so, -2, 0.4, 4); put(-so, 2, 0.4, 4);
  }
  // зебры: белые полосы 0,5 м с шагом 1 м, длиной 4 м по ходу движения; style: "yellow" — между ними жёлтые
  // (как во многих городах РФ, по умолчанию в стиле real), "white" — только белые (по умолчанию в стиле clean)
  for (const c of crosswalks) {
    const { road, at, style = zebraDefault } = typeof c === 'number' ? { road: 'z', at: c } : c;
    for (let i = -3.5; i <= 3.5; i += 1) road === 'z' ? put(i, at, 0.5, 4) : put(at, i, 4, 0.5);
    if (style === 'yellow') for (let i = -3; i <= 3; i += 1) road === 'z' ? put(i, at, 0.4, 4, true) : put(at, i, 4, 0.4, true);
  }
  inst.flush(scene);
}

/** Трамвайные пути: tram = { road: 'z' | 'x', tracks: [смещение оси пути от оси дороги, ...] }. Колея 1520 мм. */
function tramTracks(scene, M, tram) {
  const steel = new THREE.MeshStandardMaterial({ color: 0x8c8f94, metalness: 0.9, roughness: 0.25 });
  const groove = new THREE.MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.9 });
  const bed = M.asphalt.clone(); bed.color = new THREE.Color(0x8e8e8e);   // полоса покрытия вдоль путей темнее
  const L = FAR * 2;
  for (const off of tram.tracks ?? [-2, 2]) {
    const along = tram.road === 'x';
    const put = (mat, w, h, y, d) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(along ? L : w, h, along ? w : L), mat);
      m.position.set(along ? 0 : off + d, y, along ? off + d : 0); m.receiveShadow = true; scene.add(m);
    };
    put(bed, 2.3, 0.004, 0.002, 0);
    for (const r of [-0.762, 0.762]) { put(groove, 0.12, 0.006, 0.004, r); put(steel, 0.065, 0.012, 0.006, r); }
  }
}

export function buildRoads(scene, M, roads, crosswalks, tram) {
  const hasX = roads.includes('x'), hasZ = roads.includes('z');
  // газон — под всем
  scene.add(strip(M.grass, 0, 0, 900, 900, -0.03));
  // асфальт: дорога по z целиком, по x — две половины (без наложения в центре)
  if (hasZ) scene.add(strip(M.asphalt, 0, 0, W, FAR * 2, 0));
  if (hasX) {
    if (hasZ) {
      const L = FAR - W / 2;
      scene.add(strip(M.asphalt, W / 2 + L / 2, 0, L, W, 0));
      scene.add(strip(M.asphalt, -W / 2 - L / 2, 0, L, W, 0));
    } else scene.add(strip(M.asphalt, 0, 0, FAR * 2, W, 0));
  }
  // тротуары: на перекрёстке разрезаны, углы закрываем квадратами плитки
  for (const s of [-1, 1]) {
    if (hasX) {
      if (hasZ) { sidewalk(scene, M, 'x', s, W / 2, FAR); sidewalk(scene, M, 'x', s, -FAR, -W / 2); } else sidewalk(scene, M, 'x', s, -FAR, FAR);
    }
    if (hasZ) {
      if (hasX) { sidewalk(scene, M, 'z', s, W / 2, FAR); sidewalk(scene, M, 'z', s, -FAR, -W / 2); } else sidewalk(scene, M, 'z', s, -FAR, FAR);
    }
  }
  if (hasX && hasZ) {
    const k = W / 2 + (CURB + SIDEWALK) / 2, size = CURB + SIDEWALK;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) scene.add(slab(M.paving, sx * k, sz * k, size, size, KERB_H));
  }
  markings(scene, M, roads, crosswalks);
  if (tram) tramTracks(scene, M, tram);
}

/** Высота поверхности под точкой: проезжая часть 0, тротуар и газон выше. */
export function groundY(roads, x, z) {
  const onX = roads.includes('x') && Math.abs(z) < W / 2;
  const onZ = roads.includes('z') && Math.abs(x) < W / 2;
  return onX || onZ ? 0 : KERB_H;
}

// ---------- панельные дома ----------
const FLOOR = 2.8, PLINTH = 0.7;
const winGeo = { frame: new THREE.BoxGeometry(1.5, 1.55, 0.1), glass: new THREE.BoxGeometry(1.3, 1.35, 0.04), sill: new THREE.BoxGeometry(1.6, 0.06, 0.22) };
const balGeo = { slab: new THREE.BoxGeometry(3.0, 0.16, 1.1), front: new THREE.BoxGeometry(3.0, 1.0, 0.08), side: new THREE.BoxGeometry(0.08, 1.0, 1.1) };
const GLASS_TINTS = [0x1b2430, 0x22303b, 0x2a2f36, 0x3a4a55, 0x1f2a24, 0x4b5560];
const GLASS_CLEAN = [0x3a4b5e, 0x34455a, 0x415468];

/**
 * Типовой панельный дом. (cx, cz) — центр, len — длина вдоль фасада, depth — глубина,
 * rotY — поворот (0: длинная сторона вдоль x). Окна и балконы — в общий инстансинг.
 */
function panelHouse(scene, M, inst, { cx, cz, len, depth = 12, floors = 5, rotY = 0, balconies = true, brick = false }) {
  const h = PLINTH + floors * FLOOR;
  const g = new THREE.Group();
  const wall = brick ? M.brick : pick(M.plaster);
  const body = shadowed(new THREE.Mesh(boxUvInMeters(new THREE.BoxGeometry(len, h, depth)), wall));
  body.position.y = h / 2;
  g.add(body);
  g.add(shadowed(new THREE.Mesh(boxUvInMeters(new THREE.BoxGeometry(len + 0.1, PLINTH, depth + 0.1)), M.concrete)).translateY(PLINTH / 2));
  // крыша с парапетом
  g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, depth), M.roof)).translateY(h + 0.05));
  for (const [w, d, x, z] of [[len + 0.3, 0.3, 0, depth / 2], [len + 0.3, 0.3, 0, -depth / 2], [0.3, depth, len / 2, 0], [0.3, depth, -len / 2, 0]]) {
    g.add(shadowed(new THREE.Mesh(boxUvInMeters(new THREE.BoxGeometry(w, 0.5, d)), M.concrete)).translateX(x).translateY(h + 0.25).translateZ(z));
  }
  g.position.set(cx, KERB_H, cz);
  g.rotation.y = rotY;
  g.updateMatrixWorld(true);
  scene.add(g);

  // окна по сетке на обоих длинных фасадах и торцах (на торцах реже)
  const local = new THREE.Matrix4(), world = new THREE.Matrix4(), q = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1);
  const place = (x, y, z, ry, key, geo, mat, color) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    local.compose(new THREE.Vector3(x, y, z), q, s1);
    world.multiplyMatrices(g.matrixWorld, local);
    inst.add(key, geo, mat, world, color);
  };
  const cols = Math.max(2, Math.floor(len / 3));
  const step = len / cols;
  for (const side of [1, -1]) {
    const zf = side * (depth / 2), ry = side > 0 ? 0 : Math.PI;
    for (let f = 0; f < floors; f++) {
      const y = PLINTH + f * FLOOR + 1.55;
      for (let c = 0; c < cols; c++) {
        const x = -len / 2 + step * (c + 0.5);
        place(x, y, zf + side * 0.03, ry, 'frame', winGeo.frame, M.frame);
        place(x, y, zf + side * 0.085, ry, 'glass', winGeo.glass, M.glass, pick(M.clean ? GLASS_CLEAN : GLASS_TINTS));
        place(x, y - 0.8, zf + side * 0.1, ry, 'sill', winGeo.sill, M.frame);
        // балконы на уличном фасаде через колонку, начиная со 2-го этажа
        if (balconies && side > 0 && f > 0 && c % 3 === 1) {
          const yb = PLINTH + f * FLOOR;
          place(x, yb + 0.08, zf + 0.55, ry, 'bslab', balGeo.slab, M.balcony);
          place(x, yb + 0.66, zf + 1.07, ry, 'bfront', balGeo.front, M.balcony);
          place(x - 1.46, yb + 0.66, zf + 0.55, ry, 'bside', balGeo.side, M.balcony);
          place(x + 1.46, yb + 0.66, zf + 0.55, ry, 'bside', balGeo.side, M.balcony);
        }
      }
    }
  }
  for (const side of [1, -1]) {
    const xf = side * (len / 2), ry = side * Math.PI / 2;
    for (let f = 0; f < floors; f++) {
      const y = PLINTH + f * FLOOR + 1.55;
      for (const z of [-depth / 4, depth / 4]) {
        place(xf + side * 0.03, y, z, ry, 'frame', winGeo.frame, M.frame);
        place(xf + side * 0.085, y, z, ry, 'glass', winGeo.glass, M.glass, pick(M.clean ? GLASS_CLEAN : GLASS_TINTS));
      }
    }
  }
}

// ---------- деревья (EZ-Tree, процедурные, с корой и листвой) ----------
const TREE_PRESETS = ['Ash Medium', 'Oak Medium', 'Aspen Medium'];
function makeTreeVariants() {
  return TREE_PRESETS.flatMap((preset, i) => [0, 1].map((k) => {
    const t = new Tree();
    t.loadPreset(preset);
    if (preset.startsWith('Aspen')) t.options.leaves.type = LeafType.Ash;   // у осины в наборе осенние листья — нужна летняя зелень
    t.options.seed = 1000 + i * 37 + k * 11;
    t.generate();
    t.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const box = new THREE.Box3().setFromObject(t);
    return { tree: t, height: box.max.y - box.min.y };
  }));
}
// мультяшные деревья для стиля clean: ствол и крона из нескольких «шаров» (низкополигональные, гранёные)
const CROWN = [0x9fd062, 0x8cc451, 0xa9d873, 0x94c95a];
function makeCartoonTreeVariants() {
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8e6d4f, roughness: 0.9 });
  return CROWN.map((color, i) => {
    const g = new THREE.Group();
    const trunkH = 2.4 + i * 0.2;
    g.add(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, trunkH + 1, 8).translate(0, (trunkH + 1) / 2, 0), trunkMat)));
    const blobs = [];
    const n = 5 + (i % 3);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + i, r = k === 0 ? 0 : 0.9 + rnd() * 0.4;
      const R = k === 0 ? 1.9 : 1.15 + rnd() * 0.5;
      blobs.push(new THREE.IcosahedronGeometry(R, 1).translate(Math.cos(a) * r, trunkH + 1.6 + (k === 0 ? 0.4 : rnd() * 1.2 - 0.3), Math.sin(a) * r));
    }
    blobs.push(new THREE.IcosahedronGeometry(1.3, 1).translate(0.2, trunkH + 3.1, -0.1));
    g.add(shadowed(new THREE.Mesh(mergeGeometries(blobs), new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }))));
    const box = new THREE.Box3().setFromObject(g);
    return { tree: Object.assign(g, { update() {} }), height: box.max.y - box.min.y };
  });
}
function cartoonBush(M, x, z) {
  const blobs = [];
  for (let k = 0; k < 3; k++) blobs.push(new THREE.IcosahedronGeometry(0.55 + rnd() * 0.3, 1).translate((k - 1) * 0.6, 0.45 + rnd() * 0.2, rnd() * 0.4 - 0.2));
  M.bush ??= new THREE.MeshStandardMaterial({ color: 0x6fb543, roughness: 0.9, flatShading: true });
  const m = shadowed(new THREE.Mesh(mergeGeometries(blobs), M.bush));
  m.position.set(x, KERB_H, z); m.rotation.y = rnd() * 6.28;
  return m;
}

function placeTree(scene, variants, trees, x, z, height = 8 + rnd() * 4) {
  const v = pick(variants);
  const t = v.tree.clone();
  t.scale.setScalar(height / v.height);
  t.position.set(x, KERB_H, z);
  t.rotation.y = rnd() * Math.PI * 2;
  scene.add(t);
  trees.push(t);
}

// ---------- фонари ----------
function makeLamp(M) {
  const g = new THREE.Group();
  const pole = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.11, 8, 12), M.metal));
  pole.position.y = 4; g.add(pole);
  const arm = shadowed(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 7.6, 0), new THREE.Vector3(0, 8.4, 0), new THREE.Vector3(1.6, 8.3, 0)), 12, 0.045, 8), M.metal));
  g.add(arm);
  const head = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.16, 0.32), M.metal));
  head.position.set(1.75, 8.25, 0); g.add(head);
  const lens = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.02, 0.24), new THREE.MeshStandardMaterial({ color: 0xf6f2e6, roughness: 0.3, emissive: 0x2a2620 }));
  lens.position.set(1.75, 8.16, 0); g.add(lens);
  return g;
}
function placeLamp(scene, proto, x, z, towardRoadAngle) {
  const l = proto.clone();
  l.position.set(x, KERB_H, z);
  l.rotation.y = towardRoadAngle;
  scene.add(l);
}

// ---------- мелочи Poly Haven: кусты, гидранты, скамейки ----------
async function scatterProps(scene, spots, M) {
  if (M.clean) { for (const p of spots.shrubs) scene.add(cartoonBush(M, p[0], p[1])); spots.shrubs = []; }
  // фотосканы Poly Haven тяжёлые (куст ~156 тыс. треугольников) — упрощаем при загрузке
  const simplify = { shrub_01: 0.08, fire_hydrant: 0.15, painted_wooden_bench: 1 };
  const [shrub, hydrant, bench] = await Promise.all(Object.entries(simplify).map(([id, r]) => loadGltf(polyHavenModel(id), { simplify: r }).catch(() => null)));
  const put = (gltf, x, z, ry, s = 1) => { if (!gltf) return; const o = gltf.scene.clone(); o.position.set(x, KERB_H, z); o.rotation.y = ry; o.scale.setScalar(s); scene.add(o); };
  for (const p of spots.shrubs) put(shrub, p[0], p[1], rnd() * 6.28, 0.9 + rnd() * 0.5);
  for (const p of spots.hydrants) put(hydrant, p[0], p[1], p[2]);
  for (const p of spots.benches) put(bench, p[0], p[1], p[2]);
}

// ---------- сборка района ----------
/** Строит всё окружение. variants — исходные деревья: их материалы общие с копиями (ветер). */
export async function buildCity(scene, scenario) {
  reseed(7);
  const clean = (scenario.scene.style ?? 'clean') === 'clean';
  const M = clean ? makeCleanMaterials() : makeMaterials();
  const roads = scenario.scene.roads ?? ['x', 'z'];
  const crosswalks = scenario.scene.crosswalks ?? [];
  buildRoads(scene, M, roads, crosswalks, scenario.scene.tram);

  const inst = new Instances();
  const variants = clean ? makeCartoonTreeVariants() : makeTreeVariants();
  const trees = [];
  const lampProto = makeLamp(M);
  const spots = { shrubs: [], hydrants: [], benches: [] };
  const hasX = roads.includes('x'), hasZ = roads.includes('z');
  const treeLine = EDGE + 1.6;       // деревья на газоне за тротуаром
  const lampLine = W / 2 + CURB + 0.5;
  const clearZone = hasX && hasZ ? 16 : 0;   // у перекрёстка ничего не загораживает обзор

  // вдоль каждой дороги: деревья, фонари, кусты
  for (const axis of ['x', 'z']) {
    if (!roads.includes(axis)) continue;
    for (const side of [-1, 1]) {
      for (let s = -FAR + 6; s < FAR - 6; s += 9 + rnd() * 3) {
        if (Math.abs(s) < clearZone + 2) continue;
        if (!hasX || !hasZ ? (scenario.scene.crosswalks ?? []).some((c) => Math.abs(s - (typeof c === 'number' ? c : c.at)) < 5) : false) continue;
        const off = side * (treeLine + rnd() * 0.8);
        const th = clean ? 6.5 + rnd() * 2 : undefined;
        axis === 'x' ? placeTree(scene, variants, trees, s, off, th) : placeTree(scene, variants, trees, off, s, th);
      }
      for (let s = -FAR + 15; s < FAR; s += 32) {
        if (Math.abs(s) < clearZone) continue;
        // фонарь стоит у бордюра и смотрит на дорогу
        if (axis === 'x') placeLamp(scene, lampProto, s, side * lampLine, side > 0 ? Math.PI / 2 : -Math.PI / 2);
        else placeLamp(scene, lampProto, side * lampLine, s, side > 0 ? Math.PI : 0);
      }
      for (let s = -FAR + 20; s < FAR; s += 7) {
        if (Math.abs(s) < clearZone + 6 || rnd() < 0.5) continue;
        const off = side * (EDGE + 6.5 + rnd() * 1.5);
        spots.shrubs.push(axis === 'x' ? [s, off] : [off, s]);
      }
    }
  }
  // по одному гидранту и скамейке у каждого квартала
  const k = EDGE - 0.5;
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    if (hasX) { spots.hydrants.push([sx * 22, sz * k, 0]); spots.benches.push([sx * 30, sz * (EDGE + 1.2), sz > 0 ? Math.PI : 0]); }
    else if (hasZ) { spots.hydrants.push([sx * k, sz * 22, 0]); spots.benches.push([sx * (EDGE + 1.2), sz * 30, sx > 0 ? -Math.PI / 2 : Math.PI / 2]); }
  }

  // дома: первая линия вдоль дорог + дальние ряды до горизонта
  const front = EDGE + 9;   // фасад в 9 м от тротуара
  const houses = [];
  if (hasX && hasZ) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      houses.push({ cx: sx * (front + 6 + 30), cz: sz * (front + 6), len: 54, rotY: sz > 0 ? Math.PI : 0, floors: 5 });   // уличный фасад (+z дома) смотрит на дорогу
      houses.push({ cx: sx * (front + 6), cz: sz * (front + 12 + 40), len: 60, rotY: sx > 0 ? -Math.PI / 2 : Math.PI / 2, floors: 9, balconies: false, brick: rnd() < 0.3 });
    }
  } else {
    const along = hasZ ? 'z' : 'x';
    for (const side of [-1, 1]) for (let s = -140; s <= 140; s += 66) {
      const floors = rnd() < 0.5 ? 5 : 9;
      if (along === 'z') houses.push({ cx: side * (front + 6), cz: s, len: 58, rotY: side > 0 ? -Math.PI / 2 : Math.PI / 2, floors });
      else houses.push({ cx: s, cz: side * (front + 6), len: 58, rotY: side > 0 ? Math.PI : 0, floors });
    }
  }
  // дальний фон: кольцо домов, чтобы не было пустого горизонта
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 9) {
    const r = 130 + rnd() * 40;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    if ((hasX && Math.abs(cz) < 30) || (hasZ && Math.abs(cx) < 30)) continue;   // не ставим на дорогу
    houses.push({ cx, cz, len: 50 + rnd() * 20, rotY: -a - Math.PI / 2, floors: rnd() < 0.6 ? 9 : 12, balconies: false });   // фасадом к центру
  }
  for (const h of houses) panelHouse(scene, M, inst, clean ? { ...h, balconies: false, brick: false } : h);
  inst.flush(scene);
  await scatterProps(scene, spots, M);
  window.__cityStats = { trees: trees.length, treeTris: variants.map((v) => v.tree.triangleCount), houses: houses.length };   // для замеров
  return { trees, variants, materials: M };
}
