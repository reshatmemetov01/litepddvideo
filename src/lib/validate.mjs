// Проверка сценария до рендера: возвращает список понятных ошибок (пустой — всё хорошо).
import { parseAnchor } from './timeline.mjs';

const OBJECT_TYPES = ['car', 'bus', 'truck', 'pedestrian'];
const LIGHT_STATES = ['red', 'yellow', 'green', 'off'];
const SIGN_TYPES = ['main_road', 'yield', 'stop', 'ped_crossing'];
const ROADS = [['x', 'z'], ['z'], ['x']];

export function validateScenario(s) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!s || typeof s !== 'object') return ['Сценарий должен быть JSON-объектом'];

  const nPhrases = Array.isArray(s.voiceover) ? s.voiceover.length : 0;
  if (!nPhrases) err('voiceover: нужен список фраз озвучки');
  (s.voiceover ?? []).forEach((v, i) => { if (!v?.text?.trim()) err(`voiceover[${i + 1}]: пустой текст`); });

  const checkTime = (v, where) => {
    if (typeof v === 'number') return;
    const a = parseAnchor(v);
    if (!a) return err(`${where}: непонятное время «${v}» (нужно число или p3, p3.end, p3+1.5, end)`);
    if (!a.end && (a.n < 1 || a.n > nPhrases)) err(`${where}: фразы №${a.n} нет (всего ${nPhrases})`);
  };

  if (!s.scene || !ROADS.some((r) => JSON.stringify(r) === JSON.stringify(s.scene.roads))) err('scene.roads: допустимо ["x","z"], ["z"] или ["x"]');
  (s.scene?.signs ?? []).forEach((g, i) => {
    if (!SIGN_TYPES.includes(g.type)) err(`scene.signs[${i + 1}]: тип «${g.type}» неизвестен (${SIGN_TYPES.join(', ')})`);
    if (!Array.isArray(g.pos) || g.pos.length !== 2) err(`scene.signs[${i + 1}]: pos должен быть [x, z]`);
  });

  (s.scene?.lights ?? []).forEach((l, i) => {
    if (!LIGHT_STATES.includes(l.state)) err(`scene.lights[${i + 1}]: state должен быть ${LIGHT_STATES.join(', ')}`);
    if (!Array.isArray(l.pos) || l.pos.length !== 2) err(`scene.lights[${i + 1}]: pos должен быть [x, z]`);
  });
  (s.scene?.crosswalks ?? []).forEach((c, i) => {
    if (typeof c !== 'number' && !(c && ['x', 'z'].includes(c.road) && typeof c.at === 'number')) err(`scene.crosswalks[${i + 1}]: число или {road: "x"|"z", at: число}`);
  });

  const ids = new Set();
  if (!Array.isArray(s.objects) || !s.objects.length) err('objects: нужен хотя бы один объект');
  (s.objects ?? []).forEach((o) => {
    if (!o.id) return err('objects: у объекта нет id');
    if (ids.has(o.id)) err(`objects: id «${o.id}» повторяется`);
    ids.add(o.id);
    if (!OBJECT_TYPES.includes(o.type)) err(`объект «${o.id}»: тип «${o.type}» неизвестен (${OBJECT_TYPES.join(', ')})`);
    if (!Array.isArray(o.path) || o.path.length < 2) return err(`объект «${o.id}»: в path нужно минимум 2 точки`);
    o.path.forEach((p, i) => {
      if (typeof p.x !== 'number' || typeof p.z !== 'number') err(`объект «${o.id}», точка ${i + 1}: нужны числа x и z`);
      checkTime(p.t, `объект «${o.id}», точка ${i + 1}`);
    });
    if (o.blinker) { checkTime(o.blinker.t0, `объект «${o.id}», blinker.t0`); checkTime(o.blinker.t1, `объект «${o.id}», blinker.t1`); }
  });

  const needId = (id, where) => { if (typeof id === 'string' && !ids.has(id)) err(`${where}: объекта «${id}» нет`); };
  (s.labels ?? []).forEach((l, i) => { needId(l.target, `labels[${i + 1}]`); checkTime(l.t0, `labels[${i + 1}].t0`); checkTime(l.t1, `labels[${i + 1}].t1`); });
  (s.highlights ?? []).forEach((h, i) => { needId(h.target, `highlights[${i + 1}]`); checkTime(h.t0, `highlights[${i + 1}].t0`); checkTime(h.t1, `highlights[${i + 1}].t1`); });
  (s.hooks ?? []).forEach((h, i) => { checkTime(h.t0, `hooks[${i + 1}].t0`); checkTime(h.t1, `hooks[${i + 1}].t1`); });
  (s.routes ?? []).forEach((r, i) => { checkTime(r.t0, `routes[${i + 1}].t0`); checkTime(r.t1, `routes[${i + 1}].t1`); });

  if (!Array.isArray(s.camera) || !s.camera.length) err('camera: нужны ключевые кадры камеры');
  (s.camera ?? []).forEach((c, i) => {
    checkTime(c.t, `camera[${i + 1}]`);
    if (!Array.isArray(c.pos) || !Array.isArray(c.look)) err(`camera[${i + 1}]: нужны pos и look ([x, y, z])`);
  });

  if (s.card) {
    const { answers, correct, image, correctRect } = s.card;
    if (image) {
      if (!/^data:image\//.test(image) && !/^[\w./-]+\.(png|jpe?g|webp)$/i.test(image)) err('card.image: нужен путь к картинке или data:image/…');
      if (!Number.isInteger(correct) || correct < 0) err('card.correct: номер правильного ответа (с 0)');
      if (correctRect && (!Array.isArray(correctRect) || correctRect.length !== 4)) err('card.correctRect: [x, y, ширина, высота] в долях картинки (0–1)');
    } else {
      if (!s.card.question) err('card.question: нет текста вопроса');
      if (!Array.isArray(answers) || answers.length < 2) err('card.answers: нужно минимум 2 ответа');
      else if (!Number.isInteger(correct) || correct < 0 || correct >= answers.length) err('card.correct: номер правильного ответа (с 0) вне диапазона');
    }
    (s.card.windows ?? []).forEach((w, i) => w.forEach((x, k) => checkTime(x, `card.windows[${i + 1}][${k + 1}]`)));
    checkTime(s.card.reveal, 'card.reveal');
  }
  if (s.cta) { checkTime(s.cta.t0, 'cta.t0'); checkTime(s.cta.t1, 'cta.t1'); }
  return errors;
}
