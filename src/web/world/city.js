// Город: дороги, тротуары, бордюры, газоны, разметка, панельные дома, деревья, фонари, мелочи.
// Единицы — метры. Дороги: ось x и/или z через (0, 0). Движение правостороннее.
import * as THREE from 'three';
import { Tree, LeafType } from '@dgreenheck/ez-tree';
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
function makeMaterials() {
  return {
    asphalt: pbr('asphalt_02', { size: 7, color: 0xb8b8b8 }),
    paving: pbr('square_brick_paving', { size: 2.5, color: 0xc9c7c2 }),
    curb: pbr('brushed_concrete', { size: 1.5, color: 0xe6e6e6 }),
    grass: pbr('sparse_grass', { size: 3, color: 0x93c45e }),
    marking: new THREE.MeshStandardMaterial({ color: 0xcfcfc9, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
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
  const put = (x, z, sx, sz) => { m4.makeScale(sx, 1, sz).setPosition(x, 0.006, z); inst.add('mark', dash, M.marking, m4); };
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
  // зебры: полосы 0,5 м с шагом 1 м, длиной 4 м по ходу движения
  for (const c of crosswalks) {
    const { road, at } = typeof c === 'number' ? { road: 'z', at: c } : c;
    for (let i = -3.5; i <= 3.5; i += 1) road === 'z' ? put(i, at, 0.5, 4) : put(at, i, 4, 0.5);
  }
  inst.flush(scene);
}

export function buildRoads(scene, M, roads, crosswalks) {
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
        place(x, y, zf + side * 0.085, ry, 'glass', winGeo.glass, M.glass, pick(GLASS_TINTS));
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
        place(xf + side * 0.085, y, z, ry, 'glass', winGeo.glass, M.glass, pick(GLASS_TINTS));
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
async function scatterProps(scene, spots) {
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
  const M = makeMaterials();
  const roads = scenario.scene.roads ?? ['x', 'z'];
  const crosswalks = scenario.scene.crosswalks ?? [];
  buildRoads(scene, M, roads, crosswalks);

  const inst = new Instances();
  const variants = makeTreeVariants();
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
        axis === 'x' ? placeTree(scene, variants, trees, s, off) : placeTree(scene, variants, trees, off, s);
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
  for (const h of houses) panelHouse(scene, M, inst, h);
  inst.flush(scene);
  await scatterProps(scene, spots);
  window.__cityStats = { trees: trees.length, treeTris: variants.map((v) => v.tree.triangleCount), houses: houses.length };   // для замеров
  return { trees, variants, materials: M };
}
