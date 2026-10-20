// Ресурсы: PBR-текстуры Poly Haven, HDRI-небо, glTF-модели. Всё кэшируется на время рендера.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MeshoptSimplifier } from 'meshoptimizer/meshopt_simplifier.module.js';

const EXT = '/assets/ext';
const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
const pending = [];
const track = (p) => { pending.push(p); return p; };
/** Ждёт загрузки всех текстур и моделей (рендер кадров начинается только после неё). */
export const allLoaded = () => Promise.all(pending);

let maxAniso = 8;
export const setMaxAnisotropy = (n) => { maxAniso = n; };

function loadTex(url, { srgb = false, repeat = [1, 1] } = {}) {
  let t;
  track(new Promise((res, rej) => { t = texLoader.load(url, () => res(), undefined, () => rej(new Error(`Не загрузилась текстура ${url}`))); }));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * PBR-материал из текстур Poly Haven. size — сколько метров занимает одна плитка текстуры:
 * UV в геометрии задаются в метрах (см. uvInMeters), поэтому плотность одинакова на любых размерах.
 */
export function pbr(id, { size = 4, color = 0xffffff, roughness = 1, normalScale = 1, ...rest } = {}) {
  const rep = [1 / size, 1 / size];
  const base = `${EXT}/textures/${id}`;
  return new THREE.MeshStandardMaterial({
    map: loadTex(`${base}/diffuse.jpg`, { srgb: true, repeat: rep }),
    normalMap: loadTex(`${base}/nor_gl.jpg`, { repeat: rep }),
    roughnessMap: loadTex(`${base}/rough.jpg`, { repeat: rep }),
    normalScale: new THREE.Vector2(normalScale, normalScale),
    color, roughness, ...rest,
  });
}

/** Переводит UV геометрии в метры по проекции на плоскость (для дорог, стен, газонов). */
export function uvInMeters(geo, axes = 'xz') {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const [a, b] = axes;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos[`get${a.toUpperCase()}`](i), pos[`get${b.toUpperCase()}`](i));
  uv.needsUpdate = true;
  return geo;
}

/** UV для коробки «в метрах»: каждая грань — по своим двум осям (для стен домов, бордюров). */
export function boxUvInMeters(geo) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ny > 0.5) uv.setXY(i, x, z);
    else if (nx > 0.5) uv.setXY(i, z, y);
    else uv.setXY(i, x, y);
  }
  uv.needsUpdate = true;
  return geo;
}

/** HDRI-небо: освещение сцены (environment) и фон. */
export function loadSky(renderer, scene, { id = 'kloofendal_48d_partly_cloudy_puresky', intensity = 1, rotation = 0 } = {}) {
  return track(new Promise((resolve, reject) => {
    new RGBELoader().load(`${EXT}/hdri/${id}.hdr`, (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      scene.background = hdr;
      scene.environment = hdr;
      scene.environmentIntensity = intensity;
      scene.backgroundIntensity = intensity;
      scene.environmentRotation.y = rotation;
      scene.backgroundRotation.y = rotation;
      resolve(hdr);
    }, undefined, reject);
  }));
}

const gltfCache = new Map();

/** Упрощение сетки (meshoptimizer): ratio — доля треугольников, которую оставить. */
export function simplifyScene(root, ratio) {
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry.index) return;
    const g = o.geometry;
    const pos = g.attributes.position;
    if (pos.isInterleavedBufferAttribute) return;
    const positions = pos.array instanceof Float32Array ? pos.array : new Float32Array(pos.array);
    const indices = new Uint32Array(g.index.array);
    const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
    const [out] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.02);
    if (out.length >= 3) g.setIndex(new THREE.BufferAttribute(out, 1));
  });
}

/** glTF-модель (кэш по адресу). simplify — оставить такую долю треугольников (для тяжёлых фотосканов). */
export function loadGltf(url, { simplify } = {}) {
  const key = `${url}|${simplify ?? 1}`;
  if (!gltfCache.has(key)) {
    gltfCache.set(key, track(new Promise((res, rej) => gltfLoader.load(url, async (g) => {
      if (simplify && simplify < 1) { await MeshoptSimplifier.ready; simplifyScene(g.scene, simplify); }
      g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      res(g);
    }, undefined, rej))));
  }
  return gltfCache.get(key);
}
/** Упрощение части модели (после загрузки): ждёт готовности meshoptimizer. */
export async function simplifySubtree(root, ratio) { await MeshoptSimplifier.ready; simplifyScene(root, ratio); }

export const polyHavenModel = (id, res = '1k') => `${EXT}/models/${id}/${id}_${res}.gltf`;
