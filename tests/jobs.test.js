import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { api, company, memoryStorage } from './helpers.js';
import '../extension/core/job-parser.js';
import '../extension/core/jobs.js';

const source = path => readFileSync(new URL(`../extension/${path}`, import.meta.url), 'utf8');
const fixture = readFileSync(new URL('fixtures/job-collection.html', import.meta.url), 'utf8');
const LIST = 'https://www.zhipin.com/web/geek/job';
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const documentFor = (html = fixture) => parseHTML(html).document;
test('side panel places job collection below greeting script and above records', () => {
  const { document } = parseHTML(source('panel.html'));
  const order = [...document.querySelectorAll('main > section')].map(section => section.getAttribute('aria-labelledby'));
  assert.deepEqual(order, ['page-title', 'pad-title', 'jobs-title', 'records-title']);
  const actions = document.querySelector('.capture-export');
  assert.deepEqual([...actions.querySelectorAll('button')].map(button => button.id), ['jobs-export-session', 'jobs-export']);
});
function read(document, href = LIST, selection = null) {
  const page = api.createPageState(() => api.parsePage(document, href, selection), () => href, 'fixture').refresh();
  return api.parseJob(document, href, selection, page);
}
const job = () => read(documentFor()).job;
function event() { const handlers = []; return { handlers, addListener(fn) { handlers.push(fn); }, removeListener(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); }, emit(...args) { for (const fn of [...handlers]) fn(...args); } }; }

test('job extraction binds actual detail link and fields, excludes hidden/recommended/recruiter data, leaves DOM unchanged', () => {
  const document = documentFor(), original = document.toString();
  const result = read(document);
  assert.equal(result.state, 'ready');
  assert.equal(result.job.key, 'job:collection-a');
  assert.equal(result.job.url, 'https://www.zhipin.com/job_detail/collection-a.html');
  assert.equal(result.job.salary, '20-30K·13薪');
  assert.equal(result.job.city, '苏州'); assert.equal(result.job.experience, '3-5年'); assert.equal(result.job.education, '本科');
  assert.equal(result.job.description, '负责产品规划。\n要求：沟通能力。');
  assert.equal(result.job.company.key, company().key);
  assert.equal(document.toString(), original);
  assert.doesNotMatch(JSON.stringify(result), /招聘联系人|隐藏广告|synthetic-hidden/);
});
test('job extraction ignores direct-page selected-job links and hidden banner while keeping the current job fields', () => {
  const document = documentFor(`<!doctype html><html><head><title>合成直链岗位</title></head><body>
    <div class="smallbanner" style="display:none"><div class="company-info"><span class="job-name">隐藏职位名</span></div></div>
    <div class="job-detail" data-job-id="direct-job-a">
      <div class="job-detail-header"><div class="job-header-info"><div class="job-detail-info"><span class="job-name">AI业务分析</span><span class="job-salary">20-30K</span></div><ul class="tag-list"><li>苏州</li><li>3-5年</li><li>本科</li></ul></div></div>
      <a href="/job_detail/direct-job-a.html">当前职位</a>
      <div class="job-detail-body"><p class="desc">负责业务分析。</p></div>
      <div class="job-detail-section more-job-section"><div class="omnibus-job-box"><ul class="look-job-list"><li><a href="/job_detail/recommended-a.html">推荐职位甲</a></li><li><a href="/job_detail/recommended-b.html">推荐职位乙</a></li></ul></div></div>
    </div>
  </body></html>`);
  const result = read(document, 'https://www.zhipin.com/job_detail/direct-job-a.html');
  assert.equal(result.state, 'ready');
  assert.equal(result.job.key, 'job:direct-job-a');
  assert.equal(result.job.name, 'AI业务分析');
  assert.equal(result.job.description, '负责业务分析。');
});

test('job extraction refuses missing link, conflicting detail links, stale click, title mismatch, missing description and multiple visible details', () => {
  for (const change of [
    d => d.querySelector('.more-job-btn').remove(),
    d => d.querySelector('.more-job-btn').setAttribute('href', '/job_detail/collection-b.html'),
    d => { const a = d.createElement('a'); a.href = '/job_detail/other.html'; d.querySelector('.job-detail-box').append(a); },
    d => { d.querySelector('.job-detail-info .job-name').textContent = '其他职位'; },
    d => d.querySelector('.desc').remove(),
    d => d.body.append(d.querySelector('.job-detail-box').cloneNode(true))
  ]) { const d = documentFor(); change(d); assert.notEqual(read(d).state, 'ready'); }
  assert.notEqual(read(documentFor(), LIST, 'job:collection-b').state, 'ready');
});

test('job extraction handles independent detail address and validated attribute-to-card link, never invents link from attribute', () => {
  const d = documentFor(); d.querySelector('.more-job-btn').remove();
  assert.equal(read(d, 'https://www.zhipin.com/job_detail/collection-a.html').state, 'ready');
  d.querySelector('.job-detail-box').setAttribute('data-job-id', 'collection-a');
  assert.equal(read(d).job.key, 'job:collection-a');
  for (const card of d.querySelectorAll('.job-card-wrap')) card.remove();
  assert.notEqual(read(d).state, 'ready');
  assert.notEqual(read(documentFor(), 'https://www.zhipin.com/job_detail/collection-b.html').state, 'ready');
});

test('job extraction is silent on company, chat, security and hidden/preloaded details; company unknown stays separate', () => {
  assert.equal(read(documentFor(), company().url).state, 'outside');
  assert.equal(read(documentFor(), 'https://www.zhipin.com/web/geek/chat').state, 'outside');
  const d = documentFor(); d.querySelector('.job-detail-box').hidden = true;
  assert.notEqual(read(d).state, 'ready');
  const anonymous = documentFor(); for (const n of anonymous.querySelectorAll('.company-name')) n.remove();
  const result = read(anonymous); assert.equal(result.state, 'ready'); assert.equal(result.job.company, null);
  assert.equal(read(documentFor(), 'https://foreign.example/job_detail/collection-a.html').state, 'outside');
});

test('job reader blocks unchanged stale body after SPA address changes and releases after new body arrives', () => {
  const d = documentFor(); d.querySelector('.more-job-btn').remove(); for (const n of d.querySelectorAll('.job-card-wrap')) n.remove();
  let href = 'https://www.zhipin.com/job_detail/a.html';
  let now = 0;
  const reader = api.createJobReader(() => ({ href, result: read(d, href) }), () => now);
  assert.equal(reader.snapshot().state, 'waiting'); now += 500;
  const first = reader.snapshot(); assert.equal(first.state, 'ready'); assert.equal(reader.snapshot().token, first.token);
  href = 'https://www.zhipin.com/job_detail/b.html';
  assert.equal(reader.snapshot().state, 'waiting'); assert.equal(reader.snapshot().state, 'waiting');
  d.querySelector('.desc').textContent = '新岗位的职责';
  reader.snapshot(); now += 500;
  assert.equal(reader.snapshot().job.key, 'job:b');
});

test('job reader waits for description after inline title/link update and for stable fields before release', () => {
  const d = documentFor(); let now = 0;
  const reader = api.createJobReader(() => ({ href: LIST, result: read(d) }), () => now);
  reader.snapshot(); now += 500; assert.equal(reader.snapshot().job.key, 'job:collection-a');
  d.querySelector('.job-detail-info .job-name').textContent = '运营经理';
  d.querySelector('.more-job-btn').setAttribute('href', '/job_detail/collection-b.html');
  now += 1000; assert.equal(reader.snapshot().state, 'waiting'); now += 1000; assert.equal(reader.snapshot().state, 'waiting');
  d.querySelector('.desc').textContent = '运营岗位新职责';
  assert.equal(reader.snapshot().state, 'waiting'); now += 500;
  assert.equal(reader.snapshot().job.description, '运营岗位新职责');
});

test('serialized job repository keeps same-company jobs separate and preserves first time while updating, without touching company/pad data', async () => {
  const storage = memoryStorage(); storage.data['company:' + company().key] = { ...company(), markedAt: '2026-11-01T00:00:00Z' }; storage.data['settings:message-pad'] = { text: '话术' };
  const preserved = structuredClone(storage.data); let now = new Date('2026-11-06T00:00:00Z');
  const repo = api.createJobRepository(storage, () => now), a = job();
  const b = { ...a, key: 'job:collection-b', url: 'https://www.zhipin.com/job_detail/collection-b.html', name: '运营经理' };
  await Promise.all([repo.save(a, async () => {}), repo.save(b, async () => {}), repo.save(a, async () => {})]);
  assert.equal((await repo.list()).length, 2);
  now = new Date('2026-11-06T01:00:00Z'); await repo.save({ ...a, salary: '面议' }, async () => {});
  assert.equal(storage.data[a.key].firstCollectedAt, '2026-11-06T00:00:00.000Z');
  assert.equal(storage.data[a.key].lastCollectedAt, '2026-11-06T01:00:00.000Z'); assert.equal(storage.data[a.key].salary, '面议');
  for (const [key, value] of Object.entries(preserved)) assert.deepEqual(storage.data[key], value);
});

test('job repository rejects invalid identity, corrupted data, changed-page verification and failed writes, then permits retry', async () => {
  const storage = memoryStorage(), repo = api.createJobRepository(storage), a = job();
  assert.equal(api.validJob({ key: null, url: 'bad' }), null);
  assert.equal(api.validJob({ ...a, url: company().url }), null);
  assert.equal(api.validJob({ ...a, description: '' }), null);
  await assert.rejects(repo.save({ ...a, salary: '\ue032\ue036-\ue032\ue038K' }, async () => {}), /薪资尚未可靠识别/);
  assert.deepEqual(storage.data, {});
  await assert.rejects(repo.save(a, async () => { throw new Error('页面已变化'); }), /页面已变化/); assert.deepEqual(storage.data, {});
  storage.fail('set'); await assert.rejects(repo.save(a, async () => {}), /模拟保存失败/); assert.deepEqual(storage.data, {});
  storage.fail(null); await repo.save(a, async () => {});
  storage.data[a.key] = { ...storage.data[a.key], firstCollectedAt: 'broken' };
  const previous = structuredClone(storage.data); await assert.rejects(repo.save(a, async () => {}), /原岗位资料异常/);
  await assert.rejects(repo.list(), /岗位资料格式异常/); assert.deepEqual(storage.data, previous);
});

test('job CSV preserves multiline descriptions and identifiers, escapes formulas, joins current company status without writing', () => {
  const a = { ...job(), key: 'job:0000123456789012345', name: '=危险公式', description: '一行,"引号"\n下一行', firstCollectedAt: '2026-11-05T16:30:00Z', lastCollectedAt: '2026-11-06T00:00:00Z' };
  const csv = api.exportJobsCsv([a], [{ ...company(), contactedAt: '2026-11-05T00:00:00Z' }]);
  assert.ok(csv.startsWith('\uFEFF')); assert.match(csv, /job:0000123456789012345/); assert.match(csv, /'=危险公式/);
  assert.match(csv, /一行,""引号""\n下一行/); assert.match(csv, /2026-11-06 00:30/); assert.match(csv, /"是","是"/);
  assert.match(api.exportJobsCsv([a], []), /"未记录","未标记"/);
  assert.match(api.exportJobsCsv([{ ...a, company: null }], []), /"未知","未知"/);
});

function harness() {
  const { document, window } = parseHTML(fixture);
  const local = memoryStorage(), session = memoryStorage(), onChanged = event();
  for (const store of [local, session]) {
    const set = store.set; store.set = async values => { await set(values); onChanged.emit(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), store === local ? 'local' : 'session'); };
  }
  const tab = { id: 7, windowId: 3, active: true, status: 'complete', url: LIST };
  let now = Date.parse('2026-11-06T00:00:00Z');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const timers = new Map(), intervals = [], contentEvent = event(); let timer = 0, focused = true, backgroundListener;
  const network = []; let requestNumber = 0;
  let transport = async () => ({ code: 0, zpData: { jobInfo: { encryptId: 'collection-a', salaryDesc: '16-18K·13薪' }, syntheticUnused: 'not-a-saved-field' } });
  const chrome = {
    runtime: { id: 'jobs-test', onInstalled: event(), onStartup: event(), onMessage: event() },
    storage: { local: { ...local, async setAccessLevel() {} }, session, onChanged },
    sidePanel: { async setOptions() {}, async setPanelBehavior() {} },
    windows: { async get() { return { id: 3, focused }; }, async getCurrent() { return { id: 3 }; } },
    tabs: { onUpdated: event(), onRemoved: event(), onCreated: event(), onActivated: event(),
      async query() { return [{ ...tab }]; }, async get(id) { if (id !== tab.id) throw new Error('No tab'); return { ...tab }; },
      async sendMessage(id, message) {
        if (id !== tab.id) throw new Error('No tab');
        for (const fn of [...contentEvent.handlers]) { let answer; const accepted = fn(message, { id: 'jobs-test', url: 'chrome-extension://jobs-test/background.js' }, value => { answer = value; }); if (answer !== undefined || accepted) return answer; }
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
    }
  };
  function restartWorker() {
    chrome.runtime.onMessage = event();
    chrome.webRequest = { onBeforeRequest: event(), onCompleted: event(), onErrorOccurred: event() };
    const context = vm.createContext({ chrome, URL, Date, Intl, console, crypto, AbortController, setTimeout, clearTimeout,
      async fetch(url, options) { network.push({ url, options }); const body = await transport(url, options); return { ok: true, url, headers: { get: () => 'application/json' }, async text() { return JSON.stringify(body); } }; } });
    context.importScripts = (...paths) => { for (const path of paths) vm.runInContext(source(path), context); };
    vm.runInContext(source('background.js'), context); backgroundListener = chrome.runtime.onMessage.handlers[0];
  }
  function send(message, sender = { id: 'jobs-test', url: 'chrome-extension://jobs-test/panel.html' }) {
    return new Promise(resolve => { if (!backgroundListener(message, sender, resolve)) resolve(undefined); });
  }
  restartWorker();
  const location = { get href() { return tab.url; } };
  const contentChrome = { runtime: { id: 'jobs-test', onMessage: contentEvent, sendMessage: message => send(message, { id: 'jobs-test', frameId: 0, tab: { ...tab }, documentId: 'doc-a', url: tab.url }) } };
  const context = vm.createContext({ chrome: contentChrome, document, location, URL, Date: Clock, Intl, console, crypto, MutationObserver: window.MutationObserver,
    setTimeout(fn) { const id = ++timer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {} });
  function loadReader() { for (const path of ['core/identity.js', 'core/rest.js', 'core/parser.js', 'core/page-state.js', 'core/job-parser.js', 'content.js']) vm.runInContext(source(path), context); }
  loadReader();
  async function tick() { for (let i = 0; i < 3; i++) { await flush(); now += 500; const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); for (const fn of intervals) fn(); await flush(); } }
  function switchJob(key = 'collection-b', name = '运营经理') {
    const card = [...document.querySelectorAll('a.job-name')].find(n => n.getAttribute('href').includes(key));
    card.dispatchEvent(new window.Event('click', { bubbles: true }));
    document.querySelector('.job-detail-info .job-name').textContent = name;
    document.querySelector('.desc').textContent = '新岗位的工作职责。';
    document.querySelector('.more-job-btn').setAttribute('href', `/job_detail/${key}.html`);
  }
  async function request(overrides = {}) {
    const details = { requestId: 'synthetic-request-' + ++requestNumber, tabId: 7, frameId: 0, documentId: 'doc-a', method: 'GET', type: 'xmlhttprequest', initiator: 'https://www.zhipin.com', url: 'https://www.zhipin.com/wapi/zpgeek/job/detail.json?securityId=synthetic-credential', statusCode: 200, ...overrides };
    chrome.webRequest.onBeforeRequest.emit(details); await flush(); chrome.webRequest.onCompleted.emit(details); await flush();
  }
  return { document, chrome, local, session, tab, context, tick, send, switchJob, restartWorker, loadReader, network, request,
    transport(fn) { transport = fn; }, focus(value) { focused = value; },
    start: () => send({ type: 'JOBS_START', windowId: 3, tabId: 7 }), pause: () => send({ type: 'JOBS_PAUSE', windowId: 3, tabId: 7 }), status: () => send({ type: 'JOBS_STATUS', windowId: 3 }) };
}

test('actual reader/background collects only when started, pauses, deduplicates same-company jobs and exports without company writes', async () => {
  const h = harness(); await h.tick(); assert.deepEqual(h.local.data, {});
  assert.equal((await h.start()).ok, true); await h.tick();
  assert.ok(h.local.data['job:collection-a']); assert.equal(Object.keys(h.local.data).length, 1);
  assert.ok(Number.isFinite(h.session.data['job-capture:7'].lastAt));
  assert.match(h.session.data['job-capture:7'].note, /已采集/);
  assert.equal((await h.status()).session.added, 1);
  await h.tick(); assert.equal((await h.status()).session.updated, 0);
  h.switchJob(); await h.tick(); assert.ok(h.local.data['job:collection-b']); assert.equal((await h.status()).total, 2);
  const summary = await h.send({ type: 'JOBS_SUMMARY' }, { id: 'jobs-test', url: 'chrome-extension://jobs-test/dashboard.html', tab: { id: 42 } });
  assert.equal(summary.ok, true); assert.equal(summary.total, 2);
  await h.pause(); h.switchJob('collection-a', '产品经理'); await h.tick(); assert.equal((await h.status()).session.running, false);
  assert.equal((await h.status()).total, 2);
  const exported = await h.send({ type: 'JOBS_EXPORT', windowId: 3 }); assert.equal(exported.ok, true); assert.equal(exported.count, 2); assert.match(exported.csv, /collection-a.html/);
  assert.ok(Object.keys(h.local.data).every(k => k.startsWith('job:')));
});
test('session export contains only current-session jobs while all export keeps retained jobs', async () => {
  const h = harness(); await h.tick(); await h.start(); await h.tick();
  const extra = { ...job(), key: 'job:collection-b', url: 'https://www.zhipin.com/job_detail/collection-b.html', firstCollectedAt: '2026-11-01T00:00:00Z', lastCollectedAt: '2026-11-01T00:00:00Z' };
  await h.local.set({ [extra.key]: extra });
  assert.equal((await h.status()).session.sessionCount, 1);
  const current = await h.send({ type: 'JOBS_EXPORT', windowId: 3, tabId: 7, scope: 'session' });
  assert.equal(current.ok, true); assert.equal(current.count, 1); assert.match(current.csv, /collection-a/); assert.doesNotMatch(current.csv, /collection-b/);
  const all = await h.send({ type: 'JOBS_EXPORT', windowId: 3, scope: 'all' });
  assert.equal(all.count, 2); assert.match(all.csv, /collection-a/); assert.match(all.csv, /collection-b/);
  await h.pause();
  const paused = await h.send({ type: 'JOBS_EXPORT', windowId: 3, tabId: 7, scope: 'session' });
  assert.equal(paused.count, 1);
  await h.start();
  const restarted = await h.send({ type: 'JOBS_EXPORT', windowId: 3, tabId: 7, scope: 'session' });
  assert.equal(restarted.count, 0);
});

test('worker and reader restarts retain active session while tab close ends it and browser session reset defaults off', async () => {
  const h = harness(); await h.tick(); await h.start(); await h.tick();
  const id = (await h.status()).session.id; h.restartWorker();
  assert.equal((await h.status()).session.id, id);
  h.switchJob(); await h.tick(); assert.ok(h.local.data['job:collection-b']);
  vm.runInContext('BossTracker.reader.dispose()', h.context); h.loadReader(); await h.tick();
  assert.equal((await h.status()).session.id, id);
  h.chrome.tabs.onRemoved.emit(7); await h.tick(); assert.equal((await h.status()).session, null);
  assert.equal((await h.status()).total, 2);
  for (const key of Object.keys(h.session.data)) delete h.session.data[key];
  h.restartWorker(); assert.equal((await h.status()).session, null);
});

test('background rejects foreign/panel-tab/subframe/unbound signals, inactive pages and stale document without saving', async () => {
  const h = harness(); await h.tick();
  for (const sender of [{ id: 'foreign', url: 'chrome-extension://jobs-test/panel.html' }, { id: 'jobs-test', url: 'https://www.zhipin.com/', tab: { id: 7 } }, { id: 'jobs-test', url: 'chrome-extension://jobs-test/dashboard.html', tab: { id: 42 } }]) assert.equal(await h.send({ type: 'JOBS_START', windowId: 3 }, sender), undefined);
  const dashboard = { id: 'jobs-test', url: 'chrome-extension://jobs-test/dashboard.html', tab: { id: 42 } };
  const summary = await h.send({ type: 'JOBS_SUMMARY' }, dashboard);
  assert.equal(summary.ok, true); assert.equal(summary.total, 0);
  assert.equal(await h.send({ type: 'JOBS_SUMMARY' }, { id: 'jobs-test', url: 'chrome-extension://jobs-test/panel.html' }), undefined);
  assert.equal(await h.send({ type: 'JOBS_SUMMARY' }, { ...dashboard, id: 'foreign' }), undefined);
  const sender = { id: 'jobs-test', frameId: 0, documentId: 'old-doc', tab: { ...h.tab }, url: LIST };
  assert.equal((await h.send({ type: 'JOBS_SIGNAL', sessionId: 'unbound', token: 'x', href: LIST }, sender)).inactive, true);
  assert.equal(await h.send({ type: 'JOBS_CONTEXT' }, { ...sender, frameId: 1 }), undefined);
  await h.start(); const state = (await h.status()).session;
  const raw = await h.chrome.tabs.sendMessage(7, { type: 'GET_JOB', sessionId: state.id });
  const stale = await h.send({ type: 'JOBS_SIGNAL', sessionId: state.id, token: raw.token, href: LIST }, sender);
  assert.equal(stale.captured, false); assert.deepEqual(h.local.data, {});
  await h.pause(); h.focus(false); assert.equal((await h.start()).ok, false); assert.deepEqual(h.local.data, {});
});

test('save failure is visible, retry succeeds and collection failure never changes existing company or pad records', async () => {
  const h = harness(); await h.tick(); h.local.data['company:' + company().key] = { ...company(), markedAt: '2026-11-01T00:00:00Z' }; h.local.data['settings:message-pad'] = { text: '保留话术' };
  const preserved = structuredClone(h.local.data); h.local.fail('set'); await h.start(); await h.tick();
  assert.equal((await h.status()).session.failed, 1); assert.match((await h.status()).session.error, /模拟保存失败/); assert.deepEqual(h.local.data, preserved);
  h.local.fail(null); await h.start(); await h.tick(); assert.ok(h.local.data['job:collection-a']);
  for (const [key, value] of Object.entries(preserved)) assert.deepEqual(h.local.data[key], value);
});

test('queued pause completes only after accepted save, and no subsequent job is captured after pause response', async () => {
  const h = harness(); await h.tick(); let release, entered;
  const saved = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const original = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async values => { if (Object.keys(values).some(k => k.startsWith('job:'))) { entered(); await gate; } return original(values); };
  await h.start(); const ticking = h.tick(); await saved;
  let paused = false; const pausing = h.pause().then(() => { paused = true; });
  await flush(); assert.equal(paused, false); release(); await ticking; await pausing;
  const prior = structuredClone(h.local.data); h.switchJob(); await h.tick(); assert.deepEqual(h.local.data, prior);
});

test('a detail switch between backend reads never saves stale job data under its old or new identity', async () => {
  const h = harness(); await h.tick(); await h.start(); await h.tick();
  const original = h.chrome.tabs.sendMessage; let changed = false;
  h.chrome.tabs.sendMessage = async (id, message, options) => {
    const result = await original(id, message, options);
    if (message.type === 'GET_JOB' && result?.state === 'ready' && result.job.key === 'job:collection-b' && !changed) { changed = true; h.switchJob('collection-a', '产品经理'); }
    return result;
  };
  h.switchJob(); await h.tick(); assert.equal(changed, true);
  assert.equal(h.local.data['job:collection-b'], undefined);
  assert.match(h.local.data['job:collection-a'].description, /负责产品规划/);
});

test('background-tab collection is rejected and returning focus retries same visible job without touching company data', async () => {
  const h = harness(); await h.tick(); await h.start(); await h.tick();
  h.tab.active = false; h.switchJob(); await h.tick(); assert.equal(h.local.data['job:collection-b'], undefined);
  h.tab.active = true;
  h.document.defaultView.dispatchEvent(new h.document.defaultView.Event('focus'));
  await h.tick(); assert.ok(h.local.data['job:collection-b']);
  assert.ok(Object.keys(h.local.data).every(key => key.startsWith('job:')));
});

test('collector UI drives actual start/pause/retry/export and reports storage failures without changing existing data', async () => {
  const h = harness(); await h.tick();
  const { document } = parseHTML(source('panel.html')); const blobs = [];
  class TestURL extends URL { static createObjectURL(blob) { blobs.push(blob); return 'blob:jobs-export'; } static revokeObjectURL() {} }
  const chrome = { ...h.chrome, runtime: { ...h.chrome.runtime, sendMessage: h.send } };
  const context = vm.createContext({ chrome, document, URL: TestURL, Blob, Date, Intl, console, setInterval() {}, setTimeout() {} });
  for (const path of ['core/identity.js', 'core/rest.js', 'core/records.js', 'core/jobs.js']) vm.runInContext(source(path), context);
  await vm.runInContext(`(async () => { ${source('collector.js').replace(/^import .*;\r?\n/gm, '')} })()`, context);
  const button = id => document.getElementById(id);
  assert.equal(button('jobs-toggle').disabled, false); assert.equal(button('jobs-export').disabled, true);
  h.local.fail('set'); button('jobs-toggle').click(); await h.tick();
  assert.match(button('jobs-note').textContent, /模拟保存失败/); assert.equal(button('jobs-retry').hidden, false);
  assert.equal(button('jobs-export').disabled, true);
  h.local.fail(null); button('jobs-retry').click(); await h.tick();
  assert.equal(button('jobs-export-session').disabled, false);
  assert.match(button('jobs-export-session').textContent, /导出本次（1）/);
  assert.equal(button('jobs-export').disabled, false); assert.match(button('jobs-count').textContent, /累计 1 个岗位/);
  button('jobs-export-session').click(); await flush(); assert.equal(blobs.length, 1); assert.match(await blobs[0].text(), /job:collection-a/);
  button('jobs-export').click(); await flush(); assert.equal(blobs.length, 2); assert.match(await blobs[1].text(), /job:collection-a/);
  assert.match(button('jobs-note').textContent, /CSV/);
  button('jobs-toggle').click(); await h.tick(); assert.equal(button('jobs-toggle').textContent, '开始采集本页');
  assert.equal((await h.status()).session.running, false);
});
test('collector drops historical salary reminders and expires failure reasons', async () => {
  const h = harness(); await h.tick();
  const { document } = parseHTML(source('panel.html'));
  const chrome = { ...h.chrome, runtime: { ...h.chrome.runtime, sendMessage: h.send } };
  const context = vm.createContext({ chrome, document, URL, Blob, Date, Intl, console, setInterval() {}, setTimeout() {} });
  for (const path of ['core/identity.js', 'core/rest.js', 'core/records.js', 'core/jobs.js']) vm.runInContext(source(path), context);
  await vm.runInContext(`(async () => { ${source('collector.js').replace(/^import .*;\r?\n/gm, '')} })()`, context);
  const button = id => document.getElementById(id);
  const old = { running: true, id: 'capture-note', added: 0, updated: 0, failed: 1, error: '薪资为特殊字体或尚未取得，请在采集开启时重新打开这个岗位。', note: '', lastAt: Date.now() - 9000 };
  await h.session.set({ 'job-capture:7': old }); await h.tick();
  assert.doesNotMatch(button('jobs-note').textContent, /特殊字体/);
  assert.equal(button('jobs-retry').hidden, true);
  await h.session.set({ 'job-capture:7': { ...old, lastAt: Date.now() } }); await h.tick();
  assert.match(button('jobs-note').textContent, /特殊字体/);
  assert.equal(button('jobs-retry').hidden, false);
  await h.local.set({ [job().key]: { ...job(), salary: '\ue032\ue036-\ue032\ue038K' } }); await h.tick();
  assert.doesNotMatch(button('jobs-note').textContent, /历史岗位|待重新采集/);
});

const encodedSalary = '\ue032\ue036-\ue032\ue038K';
function encodeSalary(h) { h.document.querySelector('.job-detail-info .job-salary').textContent = encodedSalary; }

test('encoded DOM salary waits; observed detail API salary is joined to exact visible job, saved and exported without other data', async () => {
  const h = harness(); encodeSalary(h); await h.tick(); await h.start(); await h.tick();
  assert.deepEqual(h.local.data, {}); assert.equal(h.network.length, 0); assert.match((await h.status()).session.note, /重新打开/);
  await h.request(); await h.tick();
  const saved = h.local.data['job:collection-a']; assert.ok(saved);
  assert.equal(saved.salary, '16-18K·13薪'); assert.equal(saved.salarySource, 'detail-api');
  assert.equal(saved.url, 'https://www.zhipin.com/job_detail/collection-a.html');
  const result = await h.send({ type: 'JOBS_EXPORT', windowId: 3 });
  assert.match(result.csv, /16-18K·13薪/); assert.match(result.csv, /BOSS职位详情接口/);
  assert.doesNotMatch(JSON.stringify([h.local.data, h.session.data, result]), /[\ue000-\uf8ff]|synthetic-credential|not-a-saved-field|zpData/);
  assert.ok(Object.keys(h.local.data).every(key => key.startsWith('job:')));
});

test('API salary takes priority over readable DOM text and does not require a new DOM token to update', async () => {
  const h = harness(); await h.tick(); await h.start(); await h.tick();
  const first = h.local.data['job:collection-a'].firstCollectedAt;
  assert.equal(h.local.data['job:collection-a'].salary, '20-30K·13薪');
  await h.request(); await h.tick(); assert.equal(h.local.data['job:collection-a'].salary, '16-18K·13薪');
  assert.equal(h.local.data['job:collection-a'].firstCollectedAt, first); assert.equal((await h.status()).session.updated, 1);
});

test('legacy encoded records are preserved and visibly flagged, then repaired by recollecting the same job while first time/company/pad survive', async () => {
  const h = harness(); encodeSalary(h);
  h.local.data['job:collection-a'] = { ...job(), salary: encodedSalary, firstCollectedAt: '2026-11-01T00:00:00Z', lastCollectedAt: '2026-11-02T00:00:00Z' };
  h.local.data['company:' + company().key] = { ...company(), markedAt: '2026-11-01T00:00:00Z' };
  h.local.data['settings:message-pad'] = { text: '保留原话术' };
  const preserved = structuredClone(h.local.data);
  assert.equal((await h.status()).salaryPending, 1);
  const before = await h.send({ type: 'JOBS_EXPORT', windowId: 3 }); assert.equal(before.salaryPending, 1); assert.match(before.csv, /待重新采集/); assert.doesNotMatch(before.csv, /[\ue000-\uf8ff]/);
  assert.deepEqual(h.local.data, preserved);
  await h.tick(); await h.start(); await h.tick(); await h.request(); await h.tick();
  assert.equal(h.local.data['job:collection-a'].salary, '16-18K·13薪'); assert.equal(h.local.data['job:collection-a'].firstCollectedAt, '2026-11-01T00:00:00Z');
  assert.equal((await h.status()).salaryPending, 0);
  for (const [key, value] of Object.entries(preserved)) if (!key.startsWith('job:')) assert.deepEqual(h.local.data[key], value);
});

test('mismatched API job identifiers never attach a salary to the current job or create unseen jobs', async () => {
  const h = harness(); encodeSalary(h); h.transport(async () => ({ code: 0, zpData: { jobInfo: { encryptId: 'collection-b', salaryDesc: '30-40K' } } }));
  await h.tick(); await h.start(); await h.tick(); await h.request(); await h.tick();
  assert.deepEqual(h.local.data, {}); assert.match((await h.status()).session.note, /尚未对应/);
});

test('API failure remains explicit and retry never creates unobserved network requests; a fresh genuine request recovers', async () => {
  const h = harness(); encodeSalary(h); h.transport(async () => ({ code: 37, message: 'synthetic-credential' }));
  await h.tick(); await h.start(); await h.tick(); await h.request(); await h.tick();
  assert.deepEqual(h.local.data, {}); assert.equal(h.network.length, 1); assert.match((await h.status()).session.error, /重新打开/);
  await h.start(); await h.tick(); assert.equal(h.network.length, 1);
  h.transport(async () => ({ code: 0, zpData: { jobInfo: { encryptId: 'collection-a', salaryDesc: '面议' } } }));
  await h.request(); await h.tick(); assert.equal(h.network.length, 2); assert.equal(h.local.data['job:collection-a'].salary, '面议'); assert.equal((await h.status()).session.error, '');
});

test('pause is responsive during a slow API read, aborts it, rejects its late result and does not read while paused', async () => {
  const h = harness(); encodeSalary(h); let release;
  h.transport(() => new Promise(resolve => { release = resolve; }));
  await h.tick(); await h.start(); await h.tick(); await h.request(); assert.equal(h.network.length, 1);
  assert.equal((await h.pause()).session.running, false); assert.equal(h.network[0].options.signal.aborted, true);
  release({ code: 0, zpData: { jobInfo: { encryptId: 'collection-a', salaryDesc: '16-18K' } } }); await h.tick();
  assert.deepEqual(h.local.data, {}); await h.request(); await h.tick(); assert.equal(h.network.length, 1);
});

test('background/other-tab API requests never fetch and stale API state does not survive a worker restart', async () => {
  const h = harness(); encodeSalary(h); await h.tick(); await h.start(); await h.tick();
  await h.request({ tabId: 9 }); assert.equal(h.network.length, 0);
  h.tab.active = false; await h.request(); assert.equal(h.network.length, 0);
  h.tab.active = true; await h.request(); await h.tick(); assert.equal(h.network.length, 1);
  h.restartWorker(); h.switchJob(); encodeSalary(h); await h.tick(); assert.equal(h.local.data['job:collection-b'], undefined);
  assert.equal(h.network.length, 1); assert.equal((await h.status()).total, 1);
});

test('a detail request observed during navigation is retained briefly until the new reader can verify its document', async () => {
  const h = harness(); encodeSalary(h); await h.tick(); await h.start(); await h.tick();
  vm.runInContext('BossTracker.reader.dispose()', h.context);
  h.tab.status = 'loading'; h.chrome.tabs.onUpdated.emit(7, { status: 'loading' }, { ...h.tab });
  await h.request(); assert.equal(h.network.length, 0);
  h.tab.status = 'complete'; h.loadReader(); await h.tick();
  assert.equal(h.network.length, 1); assert.equal(h.local.data['job:collection-a'].salary, '16-18K·13薪');
});
