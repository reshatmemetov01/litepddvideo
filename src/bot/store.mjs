// Хранилище роликов: data/jobs.json + папка data/jobs/<id>/ (сценарий, запись голоса, видео).
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../lib/render.mjs';

const dataDir = path.join(root, 'data');
const file = path.join(dataDir, 'jobs.json');
fs.mkdirSync(path.join(dataDir, 'jobs'), { recursive: true });

let jobs = {};
try { jobs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* первый запуск */ }
// то, что шло в момент перезапуска, помечаем прерванным
for (const j of Object.values(jobs)) if (j.status === 'rendering' || j.status === 'queued') j.status = 'interrupted';

const save = () => fs.writeFileSync(file, JSON.stringify(jobs, null, 1));
save();

export const jobDir = (id) => { const d = path.join(dataDir, 'jobs', id); fs.mkdirSync(d, { recursive: true }); return d; };

export function createJob(scenario, chatId) {
  const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 5);
  jobs[id] = { id, chatId, title: scenario.title ?? 'Без названия', status: 'new', createdAt: Date.now() };
  fs.writeFileSync(path.join(jobDir(id), 'scenario.json'), JSON.stringify(scenario, null, 1));
  save();
  return jobs[id];
}
export const getJob = (id) => jobs[id];
export const readScenario = (id) => JSON.parse(fs.readFileSync(path.join(jobDir(id), 'scenario.json'), 'utf8'));
export function updateJob(id, patch) { Object.assign(jobs[id], patch); save(); return jobs[id]; }
export const recentJobs = (chatId, n = 8) => Object.values(jobs).filter((j) => j.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt).slice(0, n);

export const allJobs = () => Object.values(jobs);
export function removeJob(id) {
  delete jobs[id];
  fs.rmSync(path.join(dataDir, 'jobs', id), { recursive: true, force: true });
  save();
}
