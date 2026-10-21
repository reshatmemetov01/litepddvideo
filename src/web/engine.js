// Движок сцены: строит 3D-мир по JSON-сценарию и умеет отрисовать любой момент времени t.
// Всё детерминировано: renderAt(t) не зависит от реального времени, поэтому кадры можно
// снимать по одному (render.mjs) и собирать в видео.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { BokehShader } from 'three/addons/shaders/BokehShader.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadSky, allLoaded, setMaxAnisotropy, loadGltf } from './world/assets.js';
import { buildCity, groundY } from './world/city.js';
import { buildAnnotations } from './world/annotations.js';
import { makeSign, makeTrafficLight, preloadSigns, mainDirectionCanvas } from './world/props.js';
import { makeVehicle, makeVehicleFromModel, prepareVehicleModel, animateVehicle } from './world/vehicles.js';
import { makePedestrian, makePedestrianFromModel, animatePedestrian, animateModelPedestrian } from './world/people.js';

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

// ---------- субтитры ----------
// Фраза показывается кусками по 2–5 слов (1–2 строки), время куска — пропорционально его длине.
function captionChunks(v, maxLen = 22) {
  const words = [];
  let color = null;
  for (const raw of v.text.split(/\s+/).filter(Boolean)) {
    const open = raw.match(/\[(g|r|y)\]/);
    if (open) color = open[1];
    const w = raw.replace(/\[\/?(g|r|y)\]/g, '');
    words.push({ w, color });
    if (/\[\/(g|r|y)\]/.test(raw)) color = null;
  }
  const chunks = [];
  let cur = [];
  const len = (c) => c.reduce((s, x) => s + x.w.length + 1, 0);
  for (const x of words) {
    if (cur.length && len(cur) + x.w.length > maxLen) { chunks.push(cur); cur = []; }
    cur.push(x);
    if (/[.!?…:;—]$/.test(x.w) && len(cur) >= 12) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  // короткий хвост («автомобиль.») приклеиваем к предыдущему куску
  if (chunks.length > 1 && len(chunks.at(-1)) < 9 && len(chunks.at(-2)) + len(chunks.at(-1)) <= maxLen + 8) chunks.splice(-2, 2, [...chunks.at(-2), ...chunks.at(-1)]);
  const total = chunks.reduce((s, c) => s + len(c), 0);
  const t1 = v.t1 - 0.15;
  let t = v.t0;
  return chunks.map((c, i) => {
    const d = ((t1 - v.t0) * len(c)) / total;
    const out = { t0: t, t1: i === chunks.length - 1 ? v.t1 : t + d, html: c.map((x) => (x.color ? `<span class="c-${x.color}">${x.w}</span>` : x.w)).join(' ') };
    t += d;
    return out;
  });
}

// ---------- траектории ----------
// Таблица с шагом 1/60 с: позиция, курс, пройденный путь, скорость, ускорение, скорость поворота.
function makePath(points, defaultHeading = 0) {
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
      return { x: v * v * a.x + 2 * v * u * b.ctrl[0] + u * u * b.x, z: v * v * a.z + 2 * v * u * b.ctrl[1] + u * u * b.z };
    }
    return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u) };
  };
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, step = 1 / 60;
  const head = [], dist = [], speed = [];
  let heading = null, d = 0, prev = at(t0);
  for (let t = t0; t <= t1 + 1; t += step) {
    const p = at(t), q = at(t + 0.05);
    const dx = q.x - p.x, dz = q.z - p.z;
    if (dx * dx + dz * dz > 1e-7) {
      const h = Math.atan2(-dz, dx);
      heading = heading === null ? h : lerpAngle(heading, h, 0.12);
    }
    d += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
    head.push(heading); dist.push(d);
  }
  const first = head.find((h) => h !== null);
  for (let i = 0; i < head.length && head[i] === null; i++) head[i] = first ?? defaultHeading;
  if (!head.length) { head.push(defaultHeading); dist.push(0); }
  for (let i = 0; i < dist.length; i++) speed.push(((dist[Math.min(i + 3, dist.length - 1)] - dist[Math.max(i - 3, 0)]) / (6 * step)));
  const idx = (t) => clamp(Math.round((t - t0) / step), 0, head.length - 1);
  return {
    at,
    headingAt: (t) => head[idx(t)],
    kin: (t) => {
      const i = idx(t), j = Math.min(i + 6, speed.length - 1), k = Math.max(i - 6, 0);
      const dt = Math.max(1, j - k) * step;
      let dh = head[j] - head[k];
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      return { dist: dist[i], speed: speed[i], accel: (speed[j] - speed[k]) / dt, yawRate: dh / dt };
    },
  };
}

// ---------- глубина резкости без повторного рендера сцены ----------
// Стандартный BokehPass рисует сцену ещё раз ради карты глубины; здесь глубина берётся из
// основного прохода (depthTexture у буфера композитора) — экономия целого прохода по сцене.
class DepthBokehPass extends Pass {
  constructor(camera, { focus = 20, aperture = 0.0001, maxblur = 0.005 } = {}) {
    super();
    this.camera = camera;
    this.uniforms = THREE.UniformsUtils.clone(BokehShader.uniforms);
    Object.assign(this.uniforms, { focus: { value: focus }, aperture: { value: aperture }, maxblur: { value: maxblur } });
    this.material = new THREE.ShaderMaterial({
      defines: { DEPTH_PACKING: 0, PERSPECTIVE_CAMERA: 1 },
      uniforms: this.uniforms, vertexShader: BokehShader.vertexShader, fragmentShader: BokehShader.fragmentShader,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tColor.value = readBuffer.texture;
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.nearClip.value = this.camera.near;
    this.uniforms.farClip.value = this.camera.far;
    this.uniforms.aspect.value = this.camera.aspect;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
}

// ---------- сцена ----------
/**
 * opts.ss — суперсэмплинг (рендер в ss раз больше и сжатие — гладкие края);
 * opts.post — { bloom, ao, dof } постобработка (в черновике выключена ради скорости).
 */
export async function createEngine(canvas, overlay, scenario, size, opts = {}) {
  const { width, height } = size;
  const ss = opts.ss ?? 1;
  const post = { bloom: true, ao: false, dof: true, ...(opts.post ?? {}) };

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: ss < 2, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(ss);
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const clean = (scenario.scene.style ?? 'clean') !== 'real';   // clean и city — стилизованные
  // clean: нейтральная тонокоррекция сохраняет яркие цвета (газон, плитка); real — киношная ACES
  renderer.toneMapping = clean ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = scenario.scene.exposure ?? 1.0;
  renderer.info.autoReset = false;
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.fog = clean ? new THREE.Fog(0xd6e6f2, 160, 480) : new THREE.Fog(0xc4d2dc, 140, 420);
  const sunDir = new THREE.Vector3(-0.55, 0.62, 0.42).normalize();   // утреннее солнце, тени ложатся наискосок
  loadSky(renderer, scene, { intensity: clean ? 0.7 : 0.85, rotation: scenario.scene.skyRotation ?? 0 }).then(() => {
    if (!clean) return;
    // ровное голубое небо вместо фото облаков (HDRI остаётся источником освещения)
    const c = document.createElement('canvas'); c.width = 4; c.height = 256;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#5d9ee0'); gr.addColorStop(0.42, '#9cc7ee'); gr.addColorStop(0.5, '#dbeaf6'); gr.addColorStop(1, '#dbeaf6');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = t; scene.backgroundIntensity = 1;
  });
  const sun = new THREE.DirectionalLight(0xfff4e6, clean ? 2.4 : 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(opts.shadow ?? 4096, opts.shadow ?? 4096);   // 2048 — экономный режим (render.mjs)
  const S = 46;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 400 });
  sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.03; sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  scene.add(clean ? new THREE.HemisphereLight(0xe4efff, 0x8a9a7a, 0.7) : new THREE.HemisphereLight(0xdfe8f2, 0x6d6b62, 0.25));

  const roads = scenario.scene.roads ?? ['x', 'z'];
  const city = await buildCity(scene, scenario);
  (scenario.scene.lights ?? []).forEach((l) => scene.add(makeTrafficLight(l)));
  await preloadSigns(scenario.scene.signs);
  const signs = (scenario.scene.signs ?? []).map((s) => { const g = makeSign(s); scene.add(g); return g; });
  // «подмигивание» знака или таблички под ним: { sign: номер знака с 0, part: "sign" | "plate", t0, t1 }
  const signBlinks = (scenario.signHighlights ?? []).map((h) => {
    const g = signs[h.sign ?? 0], part = h.part === 'plate' ? g?.userData.plate : g?.userData.face;
    return part ? { h, part, base: part.scale.clone() } : null;
  }).filter(Boolean);

  // объекты сценария
  // свои модели: assets/models/models.json, в сценарии "model": "имя"
  const registry = await (await fetch('/assets/models/models.json')).json();
  const defaults = registry._defaults ?? {};
  const actors = {};
  const typeIdx = {};
  for (const [i, o] of scenario.objects.entries()) {
    let mesh;
    // транспорт без явной модели получает модели по умолчанию своего типа по очереди ("model": "procedural" — самодельная)
    const pool = defaults[o.type];
    const modelName = o.model ?? (pool?.length ? pool[(typeIdx[o.type] = (typeIdx[o.type] ?? -1) + 1) % pool.length] : null);
    if (modelName && modelName !== 'procedural') {
      const cfg = registry[modelName];
      if (!cfg) throw new Error(`Модели «${modelName}» нет в assets/models/models.json`);
      const gltf = await loadGltf(`/assets/models/${cfg.file}`);
      if (o.type !== 'pedestrian') await prepareVehicleModel(gltf, cfg);
      mesh = o.type === 'pedestrian' ? makePedestrianFromModel(o, cfg, gltf) : makeVehicleFromModel(o, cfg, gltf);
    } else mesh = o.type === 'pedestrian' ? makePedestrian(o, i) : makeVehicle(o);
    scene.add(mesh);
    actors[o.id] = { def: o, mesh, path: makePath(o.path, ((o.heading ?? 0) * Math.PI) / 180) };
  }

  // подсветка-кольцо и маршруты (поверх асфальта)
  const ringGeo = new THREE.RingGeometry(1.0, 1.18, 64);
  const rings = (scenario.highlights ?? []).map((h) => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: col(h.color) ?? 0xffd400, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 2;
    scene.add(m);
    return { h, m };
  });
  const notes = buildAnnotations(scene, scenario, actors);   // зоны, стрелки, подсветка зебры
  const ribbons = (scenario.routes ?? []).map((r) => {
    const g = new THREE.Group();
    for (let i = 0; i < r.points.length - 1; i++) {
      const [x1, z1] = r.points[i], [x2, z2] = r.points[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, 1.0), new THREE.MeshBasicMaterial({ color: col(r.color) ?? 0x7cff6b, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }));
      seg.position.set((x1 + x2) / 2, 0.03, (z1 + z2) / 2);
      seg.rotation.y = Math.atan2(-(z2 - z1), x2 - x1);
      g.add(seg);
    }
    scene.add(g);
    return { r, g };
  });

  // линии траекторий: рисуются постепенно по будущему пути объекта (pathT0…pathT1), со стрелкой на конце
  const trails = (scenario.trails ?? []).map((tr, k) => {
    // линия либо по будущему пути объекта (target + pathT0…pathT1), либо по точкам (points: [[x, z], ...])
    const pts = [];
    if (tr.points) for (const [x, z] of tr.points) pts.push(new THREE.Vector2(x, z));
    else {
      const a = actors[tr.target];
      for (let t = tr.pathT0; t <= tr.pathT1 + 1e-6; t += 0.04) {
        const p = a.path.at(t), q = pts.at(-1);
        if (!q || Math.hypot(p.x - q.x, p.z - q.y) > 0.2) pts.push(new THREE.Vector2(p.x, p.z));
      }
    }
    const w = (tr.width ?? 0.9) / 2, y = 0.07 + k * 0.004, n = pts.length;
    const pos = [], idx = [];
    pts.forEach((p, i) => {
      const a0 = pts[Math.max(i - 1, 0)], a1 = pts[Math.min(i + 1, n - 1)];
      const d = a1.clone().sub(a0).normalize();
      pos.push(p.x - d.y * w, y, p.y + d.x * w, p.x + d.y * w, y, p.y - d.x * w);
      if (i < n - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ color: col(tr.color) ?? 0x4cd964, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const line = new THREE.Mesh(geo, mat); line.renderOrder = 3;
    // стрелка
    const end = pts[n - 1], dir = end.clone().sub(pts[Math.max(n - 4, 0)]).normalize();
    const L = w * 4, Wd = w * 2.6;
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.Float32BufferAttribute([
      end.x + dir.x * L, y, end.y + dir.y * L,
      end.x - dir.y * Wd, y, end.y + dir.x * Wd,
      end.x + dir.y * Wd, y, end.y - dir.x * Wd], 3));
    const arrow = new THREE.Mesh(ag, mat); arrow.renderOrder = 3;
    scene.add(line, arrow);
    return { tr, line, arrow, mat, segs: n - 1 };
  });
  // картинка, которая «прилетает» от камеры и ложится на перекрёсток (например, схема таблички 8.13)
  // в полёте видна табличка целиком, на земле остаётся только схема дорог (белый фон растворяется)
  const decals = (scenario.decals ?? []).map((dc) => {
    const mk = (canvas) => {
      const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
      m.renderOrder = 2;
      return m;
    };
    const m = new THREE.Group();
    const plate = mk(mainDirectionCanvas(dc.roads)), lines = mk(mainDirectionCanvas(dc.roads, { linesOnly: true, color: dc.lineColor ?? '#ffffff' }));
    lines.position.y = -0.001;
    m.add(plate, lines);
    scene.add(m);
    return { dc, m, plate, lines };
  });

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.3, 900);

  // постобработка
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(ss);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));
  if (post.ao) {
    const ao = new GTAOPass(scene, camera, width * ss, height * ss);
    ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1, scale: 1 });
    composer.addPass(ao);
  }
  let bokeh = null;
  if (post.dof) {
    // глубина основного прохода пишется в текстуру — её и читает размытие
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height);
    bokeh = new DepthBokehPass(camera, { focus: 20, aperture: 0.00008, maxblur: 0.004 });
    composer.addPass(bokeh);
  }
  if (post.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(width * ss, height * ss), 0.4, 0.45, 2.2));   // светятся только фары, сигналы, светофоры
  composer.addPass(new OutputPass());

  await allLoaded();
  renderer.compile(scene, camera);

  // ---------- камера ----------
  // Ключ камеры — либо мировые координаты { pos, look }, либо привязка к объекту:
  // { follow: 'me', offset: [вперёд, вверх, вправо], look: 'me' | [x,y,z], lookOffset: [...] }.
  // focus: 'me' — глубина резкости по этому объекту.
  const tmpV = new THREE.Vector3();
  const local = (a, [f, u, r]) => {
    const h = a.mesh.rotation.y;
    // вперёд модели +x, вправо +z (в мире); поворот курса h
    return new THREE.Vector3(a.mesh.position.x + f * Math.cos(h) + r * Math.sin(h), a.mesh.position.y + u, a.mesh.position.z - f * Math.sin(h) + r * Math.cos(h));
  };
  const keyPose = (k) => {
    const pos = k.follow ? local(actors[k.follow], k.offset ?? [-8, 3, 0]) : new THREE.Vector3(...k.pos);
    let look;
    const lookTarget = k.look ?? k.follow;
    if (typeof lookTarget === 'string') look = local(actors[lookTarget], k.lookOffset ?? [2, 1, 0]);
    else look = new THREE.Vector3(...lookTarget);
    const focusObj = typeof k.focus === 'string' ? actors[k.focus] : typeof lookTarget === 'string' ? actors[lookTarget] : null;
    // глубина резкости — только на планах «на объект» (на общих почти не видна, а стоит ~30% времени кадра)
    const dof = k.dof ?? typeof lookTarget === 'string';
    return { pos, look, fov: k.fov ?? 40, dof, focus: focusObj ? focusObj.mesh.position.clone().setY(1) : look.clone() };
  };
  const camKeys = scenario.camera;
  function placeCamera(t) {
    let i = 0;
    while (i < camKeys.length - 2 && camKeys[i + 1].t <= t) i++;
    const ka = camKeys[i], kb = camKeys[Math.min(i + 1, camKeys.length - 1)];
    // cut: true у ключа — монтажная склейка: до его времени держим прошлый план, потом сразу новый
    const u = kb.cut ? (t >= kb.t ? 1 : 0) : kb.t === ka.t ? 1 : smooth(clamp((t - ka.t) / (kb.t - ka.t), 0, 1));
    const A = keyPose(ka), B = keyPose(kb);
    camera.position.lerpVectors(A.pos, B.pos, u);
    camera.fov = lerp(A.fov, B.fov, u);
    camera.updateProjectionMatrix();
    const look = A.look.clone().lerp(B.look, u);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    if (bokeh) {
      bokeh.enabled = u < 0.5 ? A.dof : B.dof;
      const focus = A.focus.clone().lerp(B.focus, u);
      bokeh.uniforms.focus.value = camera.position.distanceTo(focus);
    }
    // тени: «коробка» солнца следует за точкой взгляда, с привязкой к сетке теней (без дрожания)
    const texel = (2 * S) / sun.shadow.mapSize.x;
    const c = look.clone();
    c.x = Math.round(c.x / texel) * texel; c.z = Math.round(c.z / texel) * texel; c.y = 0;
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(sunDir, 160);
    return look;
  }

  // --- оверлей ---
  overlay.innerHTML = '';
  const el = (cls, parent = overlay) => { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; };
  const markup = (s) => s.replace(/\[(g|r|y)\](.*?)\[\/\1\]/g, '<span class="c-$1">$2</span>');

  const tag = el('tag'); tag.textContent = scenario.tag ?? 'ПДД';
  const hooks = (scenario.hooks ?? []).map((h) => { const d = el('hook ' + (h.style ?? '')); d.innerHTML = markup(h.text); return { h, d }; });
  // sub — мелкая строка над подписью («толстая» над «ГЛАВНАЯ»)
  const labels = (scenario.labels ?? []).map((l) => { const d = el('label ' + (l.style ?? '')); d.innerHTML = (l.sub ? `<small>${markup(l.sub)}</small>` : '') + markup(l.text); return { l, d }; });
  const captions = (scenario.voiceover ?? []).filter((v) => !v.noCaption).flatMap((v) => captionChunks(v).map((c) => { const d = el('caption'); d.innerHTML = c.html; return { v: c, d }; }));
  let card = null;
  if (scenario.card?.image) {
    const c = scenario.card;
    const d = el('card img');
    const src = c.image.startsWith('data:') ? c.image : '/' + c.image;
    const r = c.correctRect;
    d.innerHTML = `<div class="imgwrap"><img src="${src}">` +
      (r ? `<div class="hl" style="left:${r[0] * 100}%;top:${r[1] * 100}%;width:${r[2] * 100}%;height:${r[3] * 100}%"></div>` : '') +
      `</div><div class="badge">✓ Правильный ответ: ${c.correct + 1}</div>` +
      (c.notes ?? []).map((n) => `<div class="note">${markup(n.text)}</div>`).join('');
    const imgEl = d.querySelector('img');
    await imgEl.decode().catch(() => { throw new Error('Не удалось загрузить картинку вопроса'); });
    card = { c, d, answers: [], hl: d.querySelector('.hl'), badge: d.querySelector('.badge'), notes: [...d.querySelectorAll('.note')] };
  } else if (scenario.card) {
    const d = el('card');
    d.innerHTML = `<div class="card-h">Вопрос из билета</div>
      <div class="card-q">${scenario.card.question}</div>
      ${scenario.card.answers.map((a, i) => `<div class="ans" data-i="${i}"><b>${i + 1}</b><span>${a}</span></div>`).join('')}`;
    card = { c: scenario.card, d, answers: [...d.querySelectorAll('.ans')] };
  }
  // буквы над машинами (А, Б, В) в цветных кружках
  const markers = (scenario.markers ?? []).map((m) => { const d = el('marker ' + (m.style ?? '')); d.textContent = m.text; return { m, d }; });
  // подписи у стрелок на асфальте («< 5 м»)
  const groundLabels = notes.labels.map((l) => { const d = el('glabel'); d.innerHTML = markup(l.text); return { l, d }; });
  // карточка-итог: одна строка с правильным ответом
  const summary = scenario.card?.summary ? (() => {
    const c = scenario.card.summary, d = el('summary');
    d.innerHTML = (c.title ? `<div class="sum-h">${markup(c.title)}</div>` : '') + (c.question ? `<div class="sum-q">${markup(c.question)}</div>` : '') +
      `<div class="sum-a"><span>${markup(c.answer)}</span><b>✓</b></div>`;
    return { c, d };
  })() : null;
  // плашка с Telegram-каналом
  const TG = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#2aabee"/><path d="M22 49 76 28 67 73 50 61 43 68 42 57 65 37 37 54Z" fill="#fff"/><path d="M42 57 43 68 50 61Z" fill="#c8daea"/></svg>';
  const promos = (scenario.promo ?? []).map((p) => { const d = el('promo ' + (p.pos ?? 'top')); d.innerHTML = `${TG}<span>${markup(p.text)}</span>`; return { p, d }; });
  const cta = scenario.cta ? (() => { const d = el('cta'); d.innerHTML = `<div class="cta-t">${markup(scenario.cta.text)}</div><div class="cta-s">${scenario.cta.sub ?? ''}</div>`; return { c: scenario.cta, d }; })() : null;

  const vis = (d, on) => { d.style.opacity = on; d.style.display = on > 0.001 ? '' : 'none'; };
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
      const ped = a.def.type === 'pedestrian';
      a.mesh.position.set(p.x, ped ? groundY(roads, p.x, p.z) : 0, p.z);
      a.mesh.rotation.y = a.path.headingAt(t);
      if (a.def.appear) a.mesh.visible = t >= a.def.path[0].t && t <= a.def.path.at(-1).t;
      const kin = a.path.kin(t);
      if (ped) a.mesh.userData.mixer ? animateModelPedestrian(a.mesh, t, kin) : animatePedestrian(a.mesh, kin);
      else animateVehicle(a.mesh, a.def, t, kin);
    }
    for (const v of city.variants) v.tree.update(t);
    placeCamera(t);

    // подсветки
    for (const { h, m } of rings) {
      const on = win(t, h.t0, h.t1);
      m.visible = on > 0;
      const tgt = actors[h.target];
      if (tgt) m.position.set(tgt.mesh.position.x, 0.05, tgt.mesh.position.z);
      const sc = (h.size ?? 3) * (1 + Math.sin(t * 7) * 0.06);
      m.scale.set(sc, sc, sc);
      m.material.opacity = on * 0.9;
    }
    notes.update(t, win);
    for (const { part, base } of signBlinks) part.scale.copy(base);
    for (const { h, part, base } of signBlinks) {
      const on = win(t, h.t0, h.t1, 0.2);
      if (on > 0) part.scale.copy(base).multiplyScalar(1 + 0.18 * on * Math.abs(Math.sin((t - h.t0) * 5)));
    }
    for (const { tr, line, arrow, mat, segs } of trails) {
      const on = win(t, tr.t0, tr.t1);
      const prog = clamp((t - tr.t0) / (tr.draw ?? 1.6), 0, 1);
      line.visible = on > 0; arrow.visible = on > 0 && prog >= 1;
      line.geometry.setDrawRange(0, Math.round(smooth(prog) * segs) * 6);
      mat.opacity = 0.9 * on;
    }
    for (const { dc, m, plate, lines } of decals) {
      const on = win(t, dc.t0, dc.t1);
      m.visible = on > 0;
      if (!m.visible) continue;
      // сначала крупно перед камерой, потом опускается на место и становится полупрозрачной
      const f = clamp((t - dc.t0) / (dc.fly ?? 2.6), 0, 1);
      const appear = smooth(clamp(f / 0.25, 0, 1)), land = smooth(clamp((f - 0.4) / 0.6, 0, 1));
      const C = new THREE.Vector3(dc.pos?.[0] ?? 0, 0.09, dc.pos?.[1] ?? 0);
      const toC = C.clone().sub(camera.position), D = toC.length();
      const S = dc.size ?? 16;
      m.position.copy(camera.position).addScaledVector(toC.normalize(), lerp(0.4 * D, D, land));
      m.scale.setScalar(lerp(0.17 * D, S, land) * (0.6 + 0.4 * appear));   // в начале — около 60% ширины кадра
      m.rotation.y = ((dc.rot ?? 0) * Math.PI) / 180;
      plate.material.opacity = on * appear * (1 - land);
      lines.material.opacity = on * appear * land * (dc.opacity ?? 0.7);
    }
    for (const { r, g } of ribbons) {
      const on = win(t, r.t0, r.t1);
      g.visible = on > 0;
      g.children.forEach((c) => (c.material.opacity = 0.8 * on));
    }
    renderer.info.reset();
    composer.render();
    window.__renderInfo = { triangles: renderer.info.render.triangles, calls: renderer.info.render.calls };   // для замеров

    // оверлей
    for (const { h, d } of hooks) vis(d, win(t, h.t0, h.t1));
    // пока на экране карточка вопроса, субтитры опускаются ниже неё
    const cardOn = card ? Math.max(0, ...card.c.windows.map(([a, b]) => win(t, a, b, 0.35))) : 0;
    for (const { v, d } of captions) { vis(d, win(t, v.t0, v.t1, 0.06)); d.style.transform = `translateY(${cardOn * 13}rem)`; }
    for (const { l, d } of labels) {
      const on = win(t, l.t0, l.t1);
      vis(d, on);
      if (on > 0) {
        let pos;
        if (typeof l.target === 'string') {
          const m = actors[l.target].mesh;
          pos = new THREE.Vector3(m.position.x, m.position.y + (l.height ?? (m.userData.length > 6 ? 4.2 : 2.6)), m.position.z);
        } else pos = new THREE.Vector3(l.target[0], l.target[1], l.target[2]);
        const s = project(pos);
        const half = d.offsetWidth / 2 + width * 0.02;
        const x = clamp(s.x, half, width - half);
        const y = clamp(s.y, height * 0.2, height * 0.8);   // не залезать на плашку сверху
        d.style.transform = `translate(${x}px, ${y}px) translate(-50%, calc(-100% - 1.15em)) scale(${0.85 + 0.15 * on})`;   // точка на конце «ножки» — над объектом
      }
    }
    if (card) {
      const on = Math.max(0, ...card.c.windows.map(([a, b]) => win(t, a, b, 0.35)));
      vis(card.d, on);
      card.d.style.transform = `translateY(${(1 - on) * -30}px)`;
      const rev = t >= card.c.reveal;
      if (card.badge) card.badge.style.display = rev ? '' : 'none';
      if (card.hl) card.hl.style.display = rev ? '' : 'none';
      card.notes?.forEach((n, k) => vis(n, win(t, card.c.notes[k].t0, card.c.notes[k].t1)));
      card.answers.forEach((n, k) => {
        n.classList.toggle('ok', rev && k === card.c.correct);
        n.classList.toggle('dim', rev && k !== card.c.correct);
      });
    }
    for (const { m, d } of markers) {
      const on = win(t, m.t0, m.t1);
      vis(d, on);
      if (on > 0) {
        const o = actors[m.target].mesh;
        const s = project(new THREE.Vector3(o.position.x, o.position.y + (m.height ?? (o.userData.length > 6 ? 4.4 : 2.4)), o.position.z));
        d.style.transform = `translate(${s.x}px, ${clamp(s.y, height * 0.2, height * 0.85)}px) translate(-50%, -100%) scale(${0.6 + 0.4 * on})`;
      }
    }
    for (const { l, d } of groundLabels) {
      const on = win(t, l.t0, l.t1);
      vis(d, on);
      if (on > 0) { const s = project(l.pos); d.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`; }
    }
    if (summary) {
      const on = win(t, summary.c.t0, summary.c.t1, 0.35);
      vis(summary.d, on);
      summary.d.style.transform = `translateX(-50%) translateY(${(1 - on) * -30}px)`;
    }
    for (const { p, d } of promos) vis(d, win(t, p.t0, p.t1, 0.3));
    if (cta) vis(cta.d, win(t, cta.c.t0, cta.c.t1, 0.4));
  }

  return { renderAt, duration: scenario.duration };
}
