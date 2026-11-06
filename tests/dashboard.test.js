import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { company, ID_B } from './helpers.js';
const source = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
async function setup(data, fail = false, jobs = { total: 0 }, jobsFail = false) {
  const { document } = parseHTML(source('dashboard.html'));
  let listener; let records = data, broken = fail, jobTotal = jobs.total, jobBroken = jobsFail;
  const chrome = { runtime: { async sendMessage(message) {
    if (message.type === 'JOBS_SUMMARY') return jobBroken ? { ok: false } : { ok: true, total: jobTotal };
    assert.equal(message.type, 'RECORDS');
    return broken ? { ok: false } : { ok: true, records };
  } }, storage: { onChanged: { addListener(fn) { listener = fn; } } } };
  const context = vm.createContext({ document, chrome, URL, Intl, Date, console });
  for (const file of ['core/identity.js', 'core/rest.js', 'core/records.js', 'core/jobs.js']) vm.runInContext(source(file), context);
  await vm.runInContext(`(async()=>{${source('dashboard.js').replace(/^import .*;\r?\n/gm, '')}\n})()`, context);
  return { document, change(next, failure = false, nextJobs = { total: jobTotal }, nextJobsFail = jobBroken) { records = next; broken = failure; jobTotal = nextJobs.total; jobBroken = nextJobsFail; listener({ 'company:x': {} }, 'local'); }, async flush() { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); } };
}
test('dashboard counts current records, uses Shanghai dates, distinguishes unknown rest and filters names', async () => {
  const data = [{ ...company(), markedAt:'2026-11-03T16:30:00Z', contactedAt:'2026-11-04T01:00:00Z', contactSource:'manual', rest:'single' }, { ...company(ID_B, '乙公司'), markedAt:'2026-11-03T04:00:00Z' }];
  const h = await setup(data), d = h.document;
  assert.equal(d.getElementById('total').textContent, '2'); assert.equal(d.getElementById('contacted').textContent, '1'); assert.equal(d.getElementById('rate').textContent, '50%');
  assert.match(d.getElementById('trend').textContent, /2026-11-04/); assert.match(d.getElementById('rest').textContent, /未识别/);
  d.getElementById('search').value = '乙'; d.getElementById('search').dispatchEvent(new d.defaultView.Event('input'));
  assert.equal(d.querySelectorAll('#rows tr').length, 1); assert.match(d.getElementById('rows').textContent, /乙公司/);
  h.change([]); await h.flush(); assert.equal(d.getElementById('total').textContent, '0');
});
test('dashboard reports read failure without presenting zero companies', async () => {
  const h = await setup([], true);
  assert.equal(h.document.getElementById('total').textContent, '—'); assert.equal(h.document.getElementById('error').hidden, false);
});
test('dashboard shows collected jobs and keeps company data when only the job count fails', async () => {
  const data = [{ ...company(), markedAt: '2026-11-03T04:00:00Z' }];
  const h = await setup(data, false, { total: 7 }), d = h.document;
  assert.equal(d.getElementById('jobs-total').textContent, '7');
  assert.equal(d.getElementById('jobs-total-note').textContent, '当前保留的岗位');
  h.change(data, false, { total: 7 }, true); await h.flush();
  assert.equal(d.getElementById('jobs-total').textContent, '—');
  assert.equal(d.getElementById('jobs-total-note').textContent, '统计读取失败，重开看板');
  assert.equal(d.getElementById('total').textContent, '1');
  assert.equal(d.getElementById('sync').textContent, '公司数据已更新 · 岗位统计读取失败');
});
