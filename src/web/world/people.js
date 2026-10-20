// Пешеход: процедурная фигура ~1,75 м со скелетом (бёдра, колени, плечи, локти) и циклом ходьбы.
// Фаза шага берётся из пройденного пути — ноги не «скользят» по земле. Вперёд — +x.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const shadowed = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
const col = (c) => (typeof c === 'string' ? Number(c) : c);
const SKIN = [0xf1c9a5, 0xe0ac7e, 0xc68e64, 0xf5d5bc];
const HAIR = [0x2b1d14, 0x4a3222, 0x15110e, 0x7a5a3a, 0xbfa27a];
const PANTS = [0x23314f, 0x2e2e33, 0x3b3f46, 0x4a3b2c];
const STRIDE = 1.45;   // длина двойного шага, м

const mat = (c, r = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
function limb(len, r0, r1, material) {
  // сегмент, подвешенный за верхний конец (сустав в начале координат, вниз по −y)
  const g = new THREE.Group();
  const m = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry((r0 + r1) / 2, len - (r0 + r1), 6, 12), material));
  m.position.y = -len / 2;
  g.add(m);
  return g;
}

export function makePedestrian(def, seedIdx = 0) {
  const pick = (arr, k) => arr[(seedIdx * 7 + k) % arr.length];
  const skin = mat(pick(SKIN, 1), 0.6), cloth = mat(col(def.color) ?? 0xb0402a, 0.85), pants = mat(pick(PANTS, 2), 0.9);
  const shoes = mat(0x1a1a1a, 0.6), hair = mat(pick(HAIR, 3), 0.7);
  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.position.y = 0.95; root.add(hips);
  // туловище: куртка (чуть шире к плечам)
  const torso = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 6, 14), cloth));
  torso.scale.set(0.75, 1, 1.15); torso.position.y = 0.33; hips.add(torso);
  const pelvis = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.08, 6, 12), pants));
  pelvis.scale.set(0.8, 1, 1.15); pelvis.position.y = 0.02; hips.add(pelvis);
  const neck = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 10), skin)); neck.position.y = 0.66; hips.add(neck);
  const head = new THREE.Group(); head.position.y = 0.8; hips.add(head);
  const skull = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 16), skin)); skull.scale.set(1, 1.15, 0.92); head.add(skull);
  const hairCap = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.117, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hair));
  hairCap.position.set(-0.012, 0.025, 0); hairCap.scale.set(1.02, 1.15, 0.95); head.add(hairCap);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.04, 8), skin); nose.rotation.z = -Math.PI / 2; nose.position.set(0.11, -0.005, 0); head.add(nose);

  const rig = { hips, head, legs: [], arms: [] };
  for (const s of [-1, 1]) {
    // нога: бедро → колено → голень → стопа
    const thigh = limb(0.46, 0.085, 0.07, pants); thigh.position.set(0, -0.02, s * 0.1); hips.add(thigh);
    const shin = limb(0.44, 0.065, 0.05, pants); shin.position.y = -0.46; thigh.add(shin);
    const foot = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.08, 0.1), shoes)); foot.position.set(0.06, -0.47, 0); shin.add(foot);
    rig.legs.push({ thigh, shin, s });
    // рука: плечо → локоть → предплечье → кисть
    const upper = limb(0.3, 0.06, 0.05, cloth); upper.position.set(0, 0.56, s * 0.235); hips.add(upper);
    const fore = limb(0.27, 0.045, 0.04, cloth); fore.position.y = -0.3; upper.add(fore);
    const hand = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), skin)); hand.position.y = -0.3; fore.add(hand);
    upper.rotation.x = s * 0.08;   // руки чуть отведены от корпуса
    rig.arms.push({ upper, fore, s });
  }
  root.userData = { rig, height: 1.75 };
  return root;
}

/** Поза в момент t. kin.dist — пройденный путь (м), kin.speed — скорость (м/с). */
export function animatePedestrian(p, kin) {
  const { rig } = p.userData;
  const walk = THREE.MathUtils.clamp(kin.speed / 1.2, 0, 1);   // 0 — стоит, 1 — идёт
  const ph = (kin.dist / STRIDE) * Math.PI * 2;
  for (const { thigh, shin, s } of rig.legs) {
    const a = Math.sin(ph + (s > 0 ? 0 : Math.PI));
    thigh.rotation.z = -0.45 * a * walk;                            // мах бедра вперёд/назад
    // поворот вокруг z на +угол уводит конечность вперёд (+x); колено гнётся назад, локоть — вперёд
    shin.rotation.z = -(0.55 * Math.max(0, -Math.cos(ph + (s > 0 ? 0 : Math.PI))) + 0.05) * walk;   // сгиб колена при переносе ноги
  }
  for (const { upper, fore, s } of rig.arms) {
    const a = Math.sin(ph + (s > 0 ? Math.PI : 0));               // руки в противофазе ногам
    upper.rotation.z = -0.35 * a * walk;
    fore.rotation.z = (0.25 + 0.15 * Math.max(0, a)) * walk + 0.08;
  }
  rig.hips.position.y = 0.95 + Math.abs(Math.cos(ph)) * 0.035 * walk - 0.02 * walk;
  rig.hips.rotation.y = Math.sin(ph) * 0.08 * walk;
  rig.head.rotation.y = -Math.sin(ph) * 0.06 * walk;
}

// ---------- свои модели людей (glTF/GLB со скелетом, например из Mixamo) ----------

const FACING = { '+x': 0, '-x': Math.PI, '+z': Math.PI / 2, '-z': -Math.PI / 2 };

/**
 * Персонаж из модели: поворот лицом в +x (у Mixamo лицо смотрит в +z), рост cfg.height,
 * клипы ходьбы и покоя (cfg.walk / cfg.idle — имена или части имён клипов).
 */
export function makePedestrianFromModel(def, cfg, gltf) {
  const model = cloneSkinned(gltf.scene);
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  const holder = new THREE.Group();
  holder.rotation.y = FACING[cfg.forward ?? '+z'];
  holder.add(model);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const h = box.max.y - box.min.y;
  holder.scale.setScalar((cfg.height ?? 1.75) / h);
  holder.position.y = -box.min.y * holder.scale.y;
  const root = new THREE.Group();
  root.add(holder);
  const mixer = new THREE.AnimationMixer(model);
  const find = (want) => gltf.animations.find((a) => new RegExp(want, 'i').test(a.name));
  const walkClip = find(cfg.walk ?? 'walk') ?? gltf.animations[0];
  const idleClip = find(cfg.idle ?? 'idle');
  const walk = walkClip ? mixer.clipAction(walkClip) : null;
  const idle = idleClip ? mixer.clipAction(idleClip) : null;
  for (const a of [walk, idle]) if (a) { a.play(); a.paused = true; }
  root.userData = { mixer, walk, idle, stride: cfg.stride ?? STRIDE, height: cfg.height ?? 1.75 };
  return root;
}

/** Поза персонажа из модели: кадр ходьбы — по пройденному пути, покой — по времени. */
export function animateModelPedestrian(p, t, kin) {
  const { mixer, walk, idle, stride } = p.userData;
  const w = THREE.MathUtils.clamp(kin.speed / 1.2, 0, 1);
  if (walk) {
    const d = walk.getClip().duration;
    walk.time = ((kin.dist / stride) * d) % d;
    walk.setEffectiveWeight(idle ? w : 1);
  }
  if (idle) {
    const d = idle.getClip().duration;
    idle.time = t % d;
    idle.setEffectiveWeight(1 - w);
  }
  mixer.update(0);
}
