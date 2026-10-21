// Пояснения на асфальте: зоны («здесь нельзя стоять»), стрелки (в том числе двойные с размером),
// подсветка зебры. Всё плоское, лежит чуть выше разметки и плавно появляется/исчезает.
import * as THREE from 'three';
import { crosswalkStripes } from './city.js';

const col = (c, d) => (c === undefined ? d : typeof c === 'string' ? Number(c) : c);
const smooth = (u) => u * u * (3 - 2 * u);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const flat = (geo, y) => geo.rotateX(-Math.PI / 2).translate(0, y, 0);
const basic = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
export const LIME = 0xb6f23a, RED = 0xff3b30;

function rectFrame(w, l, edge) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -l / 2); s.lineTo(w / 2, -l / 2); s.lineTo(w / 2, l / 2); s.lineTo(-w / 2, l / 2); s.closePath();
  const hole = new THREE.Path();
  const a = w / 2 - edge, b = l / 2 - edge;
  hole.moveTo(-a, -b); hole.lineTo(-a, b); hole.lineTo(a, b); hole.lineTo(a, -b); hole.closePath();
  s.holes.push(hole);
  return new THREE.ShapeGeometry(s);
}

/**
 * zones:  [{ pos: [x, z] | target: "id", size: [поперёк x, вдоль z], rot: градусы, color, t0, t1, follow }]
 * arrows: [{ from: [x, z], to: [x, z], double, color, width, t0, t1, draw, label: "< 5 м", labelOffset: [x, z] }]
 * crosswalkHighlights: [{ road: "z", at: 0, color, t0, t1 }]
 * Возвращает update(t, win) и метки для оверлея (подписи у стрелок).
 */
export function buildAnnotations(scene, scenario, actors) {
  const items = [];
  const labels = [];

  for (const z of scenario.zones ?? []) {
    const color = col(z.color, RED);
    const [w, l] = z.size ?? [2.6, 5.5];
    const g = new THREE.Group();
    const fill = new THREE.Mesh(flat(new THREE.PlaneGeometry(w, l), 0.075), basic(color, 0.35));
    const frame = new THREE.Mesh(flat(rectFrame(w, l, z.edge ?? 0.22), 0.08), basic(color, 1));
    fill.renderOrder = 3; frame.renderOrder = 3;
    g.add(fill, frame);
    g.rotation.y = ((z.rot ?? 0) * Math.PI) / 180;
    scene.add(g);
    const place = (t) => {
      if (z.target && (z.follow || !g.userData.placed)) {
        const a = actors[z.target];
        const p = a.path.at(z.follow ? t : z.t0);
        g.position.set(p.x + (z.offset?.[0] ?? 0), 0, p.z + (z.offset?.[1] ?? 0));
        if (z.rot === undefined) g.rotation.y = a.path.headingAt(z.follow ? t : z.t0) + Math.PI / 2;   // вдоль машины
        g.userData.placed = true;
      } else if (z.pos) g.position.set(z.pos[0], 0, z.pos[1]);
    };
    items.push((t, win) => {
      const on = win(t, z.t0, z.t1, 0.3);
      g.visible = on > 0;
      if (!g.visible) return;
      place(t);
      const pulse = 1 + 0.03 * Math.sin(t * 6);
      g.scale.set(lerp(0.85, 1, on) * pulse, 1, lerp(0.85, 1, on) * pulse);
      fill.material.opacity = 0.35 * on; frame.material.opacity = on;
    });
  }

  for (const a of scenario.arrows ?? []) {
    const color = col(a.color, LIME);
    const from = new THREE.Vector3(a.from[0], 0, a.from[1]), to = new THREE.Vector3(a.to[0], 0, a.to[1]);
    const len = from.distanceTo(to), w = a.width ?? 0.9, headL = w * 1.8, headW = w * 2.4, y = 0.09;
    const g = new THREE.Group();
    g.position.copy(from);
    g.rotation.y = Math.atan2(-(to.z - from.z), to.x - from.x);   // локальная ось x — вдоль стрелки
    const mat = basic(color, 1);
    const shaftStart = a.double ? headL : 0;
    const shaft = new THREE.Mesh(flat(new THREE.PlaneGeometry(1, w).translate(0.5, 0, 0), y), mat);
    const tri = (dir) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([dir * headL, y, 0, 0, y, -headW / 2, 0, y, headW / 2], 3));
      return new THREE.Mesh(geo, mat);
    };
    const head = tri(1), tail = a.double ? tri(-1) : null;
    if (tail) tail.position.x = headL;
    for (const m of [shaft, head, tail]) if (m) { m.renderOrder = 3; g.add(m); }
    scene.add(g);
    items.push((t, win) => {
      const on = win(t, a.t0, a.t1, 0.3);
      g.visible = on > 0;
      if (!g.visible) return;
      const prog = smooth(clamp((t - a.t0) / (a.draw ?? 0.8), 0, 1));
      const end = shaftStart + (len - headL - shaftStart) * prog;
      shaft.position.x = shaftStart; shaft.scale.x = Math.max(0.001, end - shaftStart);
      head.position.x = end;
      mat.opacity = on;
    });
    if (a.label) {
      const mid = from.clone().lerp(to, 0.5);
      labels.push({ text: a.label, pos: new THREE.Vector3(mid.x + (a.labelOffset?.[0] ?? 0), 0.1, mid.z + (a.labelOffset?.[1] ?? 0)), t0: a.t0 + (a.draw ?? 0.8) * 0.6, t1: a.t1 });
    }
  }

  for (const c of scenario.crosswalkHighlights ?? []) {
    const mat = basic(col(c.color, LIME), 0);
    const g = new THREE.Group();
    for (const [x, z, sx, sz] of crosswalkStripes(c.road ?? 'z', c.at ?? 0)) {
      const m = new THREE.Mesh(flat(new THREE.PlaneGeometry(sx, sz), 0.07), mat);
      m.position.set(x, 0, z); m.renderOrder = 3; g.add(m);
    }
    scene.add(g);
    items.push((t, win) => {
      const on = win(t, c.t0, c.t1, 0.3);
      g.visible = on > 0;
      mat.opacity = on * (0.85 + 0.15 * Math.sin(t * 6));
    });
  }

  return { update: (t, win) => items.forEach((f) => f(t, win)), labels };
}
const lerp = (a, b, u) => a + (b - a) * u;
