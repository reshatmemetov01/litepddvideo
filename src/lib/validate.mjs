// Проверка сценария до рендера: возвращает список понятных ошибок (пустой — всё хорошо).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnchor } from './timeline.mjs';
import { SIGNS, PLATES } from '../web/world/sign-catalog.js';

const MODELS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'models', 'models.json');
const knownModels = () => { try { return JSON.parse(fs.readFileSync(MODELS, 'utf8')); } catch { return {}; } };

const OBJECT_TYPES = ['car', 'bus', 'truck', 'tram', 'moto', 'pedestrian'];
const LIGHT_STATES = ['red', 'yellow', 'green', 'off'];
const SIGN_TYPES = Object.keys(SIGNS);
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
  if (s.scene?.style !== undefined && !['clean', 'city', 'real'].includes(s.scene.style)) err('scene.style: "clean" (красная плитка), "city" (серая плитка, жёлтые дома) или "real" (фотореализм)');
  (s.scene?.signs ?? []).forEach((g, i) => {
    if (!SIGN_TYPES.includes(g.type)) err(`scene.signs[${i + 1}]: тип «${g.type}» неизвестен (${SIGN_TYPES.join(', ')})`);
    if (!Array.isArray(g.pos) || g.pos.length !== 2) err(`scene.signs[${i + 1}]: pos должен быть [x, z]`);
    if (g.plate && !PLATES[g.plate]) err(`scene.signs[${i + 1}]: табличка «${g.plate}» неизвестна (${Object.keys(PLATES).join(', ')})`);
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
    if (o.model !== undefined && o.model !== 'procedural' && !(o.model in knownModels())) err(`объект «${o.id}»: модели «${o.model}» нет в assets/models/models.json`);
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
  (s.trails ?? []).forEach((r, i) => {
    const w = `trails[${i + 1}]`;
    if (typeof r.target !== 'string') err(`${w}: нужен target — id объекта, по чьему пути рисовать линию`);
    needId(r.target, w);
    for (const k of ['t0', 't1', 'pathT0', 'pathT1']) checkTime(r[k], `${w}.${k}`);
  });
  (s.markers ?? []).forEach((m, i) => { const w = `markers[${i + 1}]`; if (typeof m.target !== 'string') err(`${w}: нужен target`); needId(m.target, w); if (!m.text) err(`${w}: нужна буква text`); checkTime(m.t0, `${w}.t0`); checkTime(m.t1, `${w}.t1`); });
  (s.zones ?? []).forEach((z, i) => {
    const w = `zones[${i + 1}]`;
    if (z.target !== undefined) needId(z.target, w); else if (!Array.isArray(z.pos) || z.pos.length !== 2) err(`${w}: нужен pos [x, z] или target`);
    checkTime(z.t0, `${w}.t0`); checkTime(z.t1, `${w}.t1`);
  });
  (s.arrows ?? []).forEach((a, i) => {
    const w = `arrows[${i + 1}]`;
    if (!Array.isArray(a.from) || !Array.isArray(a.to)) err(`${w}: нужны from [x, z] и to [x, z]`);
    checkTime(a.t0, `${w}.t0`); checkTime(a.t1, `${w}.t1`);
  });
  (s.crosswalkHighlights ?? []).forEach((c, i) => { checkTime(c.t0, `crosswalkHighlights[${i + 1}].t0`); checkTime(c.t1, `crosswalkHighlights[${i + 1}].t1`); });
  (s.promo ?? []).forEach((p, i) => { if (!p.text) err(`promo[${i + 1}]: нужен text`); checkTime(p.t0, `promo[${i + 1}].t0`); checkTime(p.t1, `promo[${i + 1}].t1`); });
  if (s.card?.summary) { const c = s.card.summary; if (!c.answer) err('card.summary.answer: строка ответа'); checkTime(c.t0, 'card.summary.t0'); checkTime(c.t1, 'card.summary.t1'); }
  (s.decals ?? []).forEach((d, i) => {
    const w = `decals[${i + 1}]`;
    checkTime(d.t0, `${w}.t0`); checkTime(d.t1, `${w}.t1`);
    if (!Array.isArray(d.roads?.main) || d.roads.main.length !== 2) err(`${w}.roads.main: два направления главной дороги, например ["top", "right"]`);
  });

  if (!Array.isArray(s.camera) || !s.camera.length) err('camera: нужны ключевые кадры камеры');
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
  (s.camera ?? []).forEach((c, i) => {
    const where = `camera[${i + 1}]`;
    checkTime(c.t, where);
    // ключ камеры: мировые координаты (pos) или слежение за объектом (follow + offset [вперёд, вверх, вправо])
    if (c.follow !== undefined) { needId(c.follow, `${where}.follow`); if (c.offset && !vec3(c.offset)) err(`${where}.offset: [вперёд, вверх, вправо]`); }
    else if (!vec3(c.pos)) err(`${where}: нужны pos [x, y, z] или follow: "id объекта"`);
    if (typeof c.look === 'string') needId(c.look, `${where}.look`);
    else if (c.look !== undefined && !vec3(c.look)) err(`${where}.look: [x, y, z] или id объекта`);
    else if (c.look === undefined && c.follow === undefined) err(`${where}: нужен look`);
    if (c.focus !== undefined) needId(c.focus, `${where}.focus`);
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
    (s.card.notes ?? []).forEach((n, i) => { if (!n.text) err(`card.notes[${i + 1}]: нет text`); checkTime(n.t0, `card.notes[${i + 1}].t0`); checkTime(n.t1, `card.notes[${i + 1}].t1`); });
  }
  if (s.cta) { checkTime(s.cta.t0, 'cta.t0'); checkTime(s.cta.t1, 'cta.t1'); }
  return errors;
}
