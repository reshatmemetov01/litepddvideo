// Чтобы сервер не забивался: удаляем старые ролики и мусор, следим за свободным местом.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { root } from '../lib/render.mjs';
import { allJobs, removeJob, dataDir } from './store.mjs';

const DAY = 24 * 3600 * 1000;
export const RETENTION_DAYS = +process.env.RETENTION_DAYS || 7;
export const MIN_FREE_GB = +process.env.MIN_FREE_GB || 3;

export function freeGB(dir = dataDir) {
  const s = fs.statfsSync(dir);
  return (s.bavail * s.bsize) / 2 ** 30;
}

export function dirSizeMB(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* файл исчез */ } }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total / 2 ** 20;
}

const olderThan = (p, ms) => { try { return Date.now() - fs.statSync(p).mtimeMs > ms; } catch { return false; } };

/** Удаляет ролики старше maxAgeDays (кроме идущих в рендере) и временный мусор Chromium/рендера. */
export function cleanup({ maxAgeDays = RETENTION_DAYS } = {}) {
  let removed = 0;
  const known = new Set();
  for (const j of allJobs()) {
    known.add(j.id);
    if (['queued', 'rendering'].includes(j.status)) continue;
    if (Date.now() - j.createdAt > maxAgeDays * DAY) { removeJob(j.id); removed++; }
  }
  // папки без записи в базе (например, после сбоя)
  const jobsRoot = path.join(dataDir, 'jobs');
  if (fs.existsSync(jobsRoot)) {
    for (const name of fs.readdirSync(jobsRoot)) {
      if (!known.has(name) && olderThan(path.join(jobsRoot, name), DAY)) { fs.rmSync(path.join(jobsRoot, name), { recursive: true, force: true }); removed++; }
    }
  }
  // кэш озвучки: фразы старше 30 дней не нужны (текст обычно меняется)
  const cache = path.join(dataDir, 'tts-cache');
  if (fs.existsSync(cache)) for (const name of fs.readdirSync(cache)) if (olderThan(path.join(cache, name), 30 * DAY)) { fs.rmSync(path.join(cache, name), { force: true }); removed++; }
  // временные файлы рендера и профили Chromium, оставшиеся после сбоев
  for (const dir of [path.join(dataDir, 'tmp'), os.tmpdir()]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const isTemp = dir === path.join(dataDir, 'tmp') || /^(playwright|\.org\.chromium|chromium)/i.test(name);
      const p = path.join(dir, name);
      if (isTemp && olderThan(p, 3600 * 1000)) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  return removed;
}

/** Освобождает место перед рендером: сначала обычная чистка, потом агрессивная. Возвращает свободные ГБ. */
export function ensureSpace() {
  cleanup();
  if (freeGB() < MIN_FREE_GB) cleanup({ maxAgeDays: 1 });
  if (freeGB() < MIN_FREE_GB) cleanup({ maxAgeDays: 0 });
  return freeGB();
}

export function startCleanupTimer() {
  const run = () => { try { const n = cleanup(); if (n) console.log(`[cleanup] удалено: ${n}, свободно ${freeGB().toFixed(1)} ГБ`); } catch (e) { console.error('[cleanup]', e.message); } };
  run();
  setInterval(run, 6 * 3600 * 1000).unref();
}
