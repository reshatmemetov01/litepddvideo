// Привязка времени к фразам озвучки.
// В сценарии вместо секунд можно писать якоря: "p3" (начало 3-й фразы), "p3.end" (конец),
// "p3+1.5" / "p3.end-0.3" (со сдвигом в секундах), "end" (конец ролика). Фразы нумеруются с 1.
// Когда озвучка записана, длительности фраз известны точно, и все события ложатся на голос.
// Без озвучки (черновик) длительность оценивается по длине текста.

export const LEAD_IN = 0.35;   // пауза перед первой фразой
export const GAP = 0.45;       // пауза между фразами
export const TAIL = 1.0;       // пауза после последней фразы

const TIME_KEYS = new Set(['t', 't0', 't1', 'reveal']);
const ANCHOR = /^(?:(end)|p(\d+)(?:\.(start|end))?)([+-]\d+(?:\.\d+)?)?$/;

export const estimateDuration = (text) => Math.max(1.2, text.replace(/\[\/?[gry]\]/g, '').length / 13.5);

/** Расставляет фразы во времени: [{start, end}] и общую длительность. */
export function layoutPhrases(durations, { gap = GAP, leadIn = LEAD_IN, tail = TAIL } = {}) {
  let t = leadIn;
  const phrases = durations.map((d) => {
    const p = { start: t, end: t + d };
    t = p.end + gap;
    return p;
  });
  const total = (phrases.at(-1)?.end ?? 0) + tail;
  return { phrases, total };
}

export function parseAnchor(v) {
  const m = typeof v === 'string' ? v.trim().match(ANCHOR) : null;
  if (!m) return null;
  return { end: !!m[1], n: m[2] ? +m[2] : null, edge: m[3] ?? 'start', off: m[4] ? +m[4] : 0 };
}

/** Возвращает копию сценария, где все якоря заменены секундами. */
export function resolveScenario(scenario, durations) {
  const { phrases, total } = layoutPhrases(durations);
  const at = (v, where) => {
    if (typeof v === 'number') return v;
    const a = parseAnchor(v);
    if (!a) throw new Error(`Непонятное время «${v}» (${where})`);
    if (a.end) return total + a.off;
    const p = phrases[a.n - 1];
    if (!p) throw new Error(`Фразы №${a.n} нет (${where}); всего фраз: ${phrases.length}`);
    return p[a.edge] + a.off;
  };
  const walk = (node, key, where) => {
    if (Array.isArray(node)) {
      if (key === 'windows') return node.map((w, i) => w.map((x) => at(x, `${where}[${i}]`)));
      return node.map((x, i) => walk(x, null, `${where}[${i}]`));
    }
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k, `${where}.${k}`)]));
    }
    if (TIME_KEYS.has(key) && (typeof node === 'string' || typeof node === 'number')) return at(node, where);
    return node;
  };
  const out = walk(scenario, null, 'сценарий');
  // подписи/субтитры берутся из времени фраз
  out.voiceover = scenario.voiceover.map((v, i) => ({ ...v, t0: phrases[i].start, t1: phrases[i].end + 0.15 }));
  out.duration = total;
  out.phraseTimes = phrases;
  return out;
}
