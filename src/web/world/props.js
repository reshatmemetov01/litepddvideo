// Дорожные знаки и светофоры в реальных размерах.
import * as THREE from 'three';

const KERB_H = 0.15;
const galv = new THREE.MeshStandardMaterial({ color: 0xa9adb2, roughness: 0.35, metalness: 0.85 });
const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.5, metalness: 0.4 });
const shadowed = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

// ---------- знаки: рисуем лицевую сторону на canvas ----------
function drawSign(kind, g) {
  const poly = (pts, fill, stroke, lw) => {
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.lineJoin = 'round'; g.stroke(); }
  };
  if (kind === 'main_road') {            // 2.1 Главная дорога
    poly([[256, 12], [500, 256], [256, 500], [12, 256]], '#fff', '#222', 6);
    poly([[256, 70], [442, 256], [256, 442], [70, 256]], '#f6c500', '#111', 10);
  } else if (kind === 'yield') {         // 2.4 Уступите дорогу (вершиной вниз)
    poly([[20, 60], [492, 60], [256, 470]], '#d42020', null, 0);
    poly([[98, 104], [414, 104], [256, 378]], '#fff', null, 0);
  } else if (kind === 'stop') {          // 2.5 Движение без остановки запрещено
    const pts = [];
    for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * Math.PI) / 4; pts.push([256 + 244 * Math.cos(a), 256 + 244 * Math.sin(a)]); }
    poly(pts, '#d42020', '#fff', 14);
    g.fillStyle = '#fff'; g.font = 'bold 130px Montserrat, DejaVu Sans, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('STOP', 256, 262);
  } else if (kind === 'ped_crossing') {  // 5.19.1 Пешеходный переход
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect(8, 8, 496, 496, 40); g.fill();
    g.fillStyle = '#1f5bc8'; g.beginPath(); g.roundRect(26, 26, 460, 460, 30); g.fill();
    poly([[256, 70], [440, 410], [72, 410]], '#fff', null, 0);
    g.fillStyle = '#111';
    g.beginPath(); g.arc(262, 188, 22, 0, 7); g.fill();
    g.lineCap = 'round'; g.strokeStyle = '#111'; g.lineWidth = 26;
    const line = (...p) => { g.beginPath(); g.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]); g.stroke(); };
    line(258, 220, 248, 300);                // корпус
    line(248, 300, 214, 372); line(248, 300, 290, 370);   // ноги
    line(256, 236, 216, 282); line(256, 236, 298, 270);   // руки
    g.fillStyle = '#111'; for (let i = 0; i < 4; i++) g.fillRect(150 + i * 58, 384, 34, 16);   // «зебра»
  }
}

const signTex = new Map();
function signTextures(kind) {
  if (!signTex.has(kind)) {
    const face = document.createElement('canvas'); face.width = face.height = 512;
    drawSign(kind, face.getContext('2d'));
    // силуэт для оборотной стороны: та же форма, серый металл
    const back = document.createElement('canvas'); back.width = back.height = 512;
    const b = back.getContext('2d'); b.drawImage(face, 0, 0); b.globalCompositeOperation = 'source-in'; b.fillStyle = '#9da1a6'; b.fillRect(0, 0, 512, 512);
    const tf = new THREE.CanvasTexture(face); tf.colorSpace = THREE.SRGBColorSpace; tf.anisotropy = 8;
    const tb = new THREE.CanvasTexture(back); tb.colorSpace = THREE.SRGBColorSpace;
    signTex.set(kind, { tf, tb });
  }
  return signTex.get(kind);
}

/** Знак на стойке. pos: [x, z]; rot (градусы): 0 — лицом к +z. */
export function makeSign(def) {
  const g = new THREE.Group();
  const size = def.size ?? 0.9;            // типоразмер II: ~0,9 м
  const plateY = def.height ?? 2.6;        // центр щита над тротуаром
  const pole = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, plateY + size / 2 + 0.1, 12), galv));
  pole.position.y = (plateY + size / 2 + 0.1) / 2; g.add(pole);
  g.add(shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), galv)).translateY(plateY + size / 2 + 0.1));
  const { tf, tb } = signTextures(def.type);
  const front = shadowed(new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tf, alphaTest: 0.5, roughness: 0.45, metalness: 0.0 })));
  front.position.set(0, plateY, 0.055);
  const backM = shadowed(new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tb, alphaTest: 0.5, roughness: 0.4, metalness: 0.6 })));
  backM.position.set(0, plateY, 0.05); backM.rotation.y = Math.PI;
  g.add(front, backM);
  for (const dy of [-size * 0.25, size * 0.25]) g.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.06), galv)).translateY(plateY + dy).translateZ(0.025));
  g.position.set(def.pos[0], KERB_H, def.pos[1]);
  g.rotation.y = ((def.rot ?? 0) * Math.PI) / 180;
  return g;
}

// ---------- светофор Т.1 ----------
const LAMP = { red: 0xff2a1a, yellow: 0xffb000, green: 0x19ff6a };
export function makeTrafficLight(def) {
  const g = new THREE.Group();
  const state = def.state ?? 'red';
  g.add(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 3.0, 14), galv)).translateY(1.5));
  const head = new THREE.Group();
  head.position.y = 3.15;
  head.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.36, 1.08, 0.26), darkMetal)));
  // экран: чёрная доска с белой каймой (как на новых светофорах)
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.58, 1.3, 0.02), new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6 }));
  board.position.z = -0.14; head.add(shadowed(board));
  // белая кайма видна только спереди; сзади экран чёрный
  const rimWhite = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }), rimBack = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6 });
  const rim = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.34, 0.015), [rimBack, rimBack, rimBack, rimBack, rimWhite, rimBack]);
  rim.position.z = -0.152; head.add(rim);
  const visorGeo = new THREE.CylinderGeometry(0.135, 0.135, 0.2, 18, 1, true, -Math.PI / 2, Math.PI);
  Object.entries({ red: 0.34, yellow: 0, green: -0.34 }).forEach(([k, y]) => {
    const on = state === k;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.11, 24), new THREE.MeshStandardMaterial({
      color: on ? LAMP[k] : 0x1a1a1a, emissive: on ? LAMP[k] : 0x000000, emissiveIntensity: on ? 6 : 0, roughness: 0.15,
    }));
    lens.position.set(0, y, 0.131); head.add(lens);
    const visor = shadowed(new THREE.Mesh(visorGeo, darkMetal));
    visor.rotation.x = Math.PI / 2; visor.rotation.z = Math.PI;   // козырёк сверху над линзой
    visor.position.set(0, y + 0.02, 0.23); head.add(visor);
  });
  g.add(head);
  g.position.set(def.pos[0], KERB_H, def.pos[1]);
  g.rotation.y = ((def.rot ?? 0) * Math.PI) / 180;
  return g;
}
