import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { api, company, ID_B, memoryStorage } from './helpers.js';
import '../extension/core/floating.js';
const source = path => readFileSync(new URL(`../extension/${path}`, import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function event() {
  const handlers = [];
  return { handlers, addListener(fn) { handlers.push(fn); }, removeListener(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); } };
}
async function harness({ companyPage = false, prior = false, closeAPI = true, closeImpl = null, audioState = 'running', position = null } = {}) {
  const storage = memoryStorage(), session = memoryStorage();
  if (prior) storage.data['company:' + company().key] = { ...company(), markedAt: '2026-10-01T00:00:00Z', rest: 'single' };
  if (position) storage.data['floating-position'] = { ...position };
  const tab = { id: 7, windowId: 3, active: true, status: 'complete', url: companyPage ? company().url : 'https://www.zhipin.com/web/geek/job' };
  const calls = [], intervals = new Map(), timeouts = new Map(); let nextTimer = 0, focused = true, beforeGet = null, reader;
  const audio = { starts: 0, resumes: 0, closes: 0, rejected: false };
  class AudioContext {
    constructor() { this.state = audioState; this.destination = {}; }
    createBuffer(channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() { audio.starts++; }, stop() {} }; }
    resume() { audio.resumes++; if (audio.rejected) return Promise.reject(new Error('policy')); this.state = 'running'; return Promise.resolve(); }
    close() { audio.closes++; this.state = 'closed'; return Promise.resolve(); }
  }
  const { document, window } = parseHTML(companyPage ? '<html><head><title>测试公司</title></head><body><div class="company-info"><h1>甲公司</h1></div></body></html>' : readFileSync(new URL('fixtures/inline-detail.html', import.meta.url), 'utf8'));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const businessBefore = document.toString();
  let shadow;
  const create = document.createElement.bind(document);
  document.createElement = (...args) => {
    const el = create(...args), attach = el.attachShadow.bind(el);
    el.attachShadow = options => { shadow = attach(options); return shadow; };
    return el;
  };
  const sender = () => ({ id: 'extension', url: tab.url, tab: { ...tab }, frameId: 0, documentId: 'doc-one' });
  const panelSender = { id: 'extension', url: 'chrome-extension://extension/panel.html' };
  const chrome = {
    runtime: { id: 'extension', onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local: { ...storage, async setAccessLevel() {} }, session },
    sidePanel: {
      async setPanelBehavior() {},
      async setOptions(options) { calls.push(['options', { ...options }]); },
      open(options) { calls.push(['open', { ...options }]); return Promise.resolve(); },
      ...(closeAPI ? { async close(options) { calls.push(['close', { ...options }]); if (closeImpl) await closeImpl(options); } } : {})
    },
    windows: { async get() { return { id: 3, focused }; } },
    tabs: {
      onUpdated: event(), onRemoved: event(), onCreated: event(),
      async query() { return [{ ...tab }]; },
      async get() { if (beforeGet) { const hook = beforeGet; beforeGet = null; await hook(); } return { ...tab }; },
      async sendMessage(id, message) {
        assert.equal(id, tab.id);
        let result, answered = false;
        for (const fn of [...reader.onMessage.handlers]) fn(message, { id: 'extension' }, value => { if (!answered) { result = value; answered = true; } });
        if (!answered) throw new Error('Could not establish connection. Receiving end does not exist.');
        return structuredClone(result);
      }
    }
  };
  const background = vm.createContext({ chrome, URL, Date, Intl, console });
  background.importScripts = (...paths) => { for (const path of paths) vm.runInContext(source(path), background); };
  vm.runInContext(source('background.js'), background);
  const send = (message, from = panelSender) => new Promise(resolve => {
    if (!chrome.runtime.onMessage.handlers[0](message, from, resolve)) resolve(undefined);
  });
  reader = { id: 'extension', onMessage: event(), sendMessage(message) { calls.push(['message', message.type]); return send(message, sender()); } };
  const context = vm.createContext({ document, URL, Date, console, AudioContext, chrome: { runtime: reader }, location: { get href() { return tab.url; } }, crypto: { randomUUID: () => 'reader-one' },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval(fn) { const id = ++nextTimer; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, delay = 0) { if (delay >= 250) { const id = ++nextTimer; timeouts.set(id, fn); return id; } queueMicrotask(fn); return ++nextTimer; },
    clearTimeout(id) { timeouts.delete(id); } });
  const manifest = JSON.parse(source('manifest.json'));
  for (const path of manifest.content_scripts[0].js) vm.runInContext(source(path), context);
  await flush();
  const controls = () => ({ ball: shadow.querySelector('.ball'), strip: shadow.querySelector('.strip'), contact: shadow.querySelector('.contact'), undo: shadow.querySelector('.undo'), name: shadow.querySelector('.name'), status: shadow.querySelector('.status'), when: shadow.querySelector('.when'), captureInfo: shadow.querySelector('.capture-info'), feedback: shadow.querySelector('.feedback'), wrap: shadow.querySelector('.wrap'), sound: shadow.querySelector('.sound-toggle'), unlock: shadow.querySelector('.sound-unlock'), soundStatus: shadow.querySelector('.sound-status') });
  const page = () => context.BossTracker.reader.snapshot();
  const payload = type => { const p = page(); return { type, href: p.href, token: p.token, visitId: p.visitId, key: p.current?.key }; };
  const poll = async () => { for (const fn of intervals.values()) fn(); await flush(); };
  return { storage, session, tab, calls, audio, document, businessBefore, context, reader, chrome, controls, page, payload, send, sender, panelSender, poll,
    async idle() { await flush(); },
    focus(value) { focused = value; }, delayGet(fn) { beforeGet = fn; },
    fire(el, name, detail = 0) { const event = new window.Event(name, { bubbles: true }); Object.defineProperty(event, 'detail', { value: detail }); el.dispatchEvent(event); },
    pointer(el, name, init = {}) {
      const event = new window.Event(name, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: 0, clientY: 0, ...init })) Object.defineProperty(event, key, { value });
      el.dispatchEvent(event);
      return event;
    },
    resize(width, height) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
      window.dispatchEvent(new window.Event('resize'));
    },
    async runTimers() { const pending = [...timeouts.values()]; timeouts.clear(); for (const fn of pending) fn(); await flush(); },
    async navigateB() { document.querySelector('.job-detail').setAttribute('data-job-id', 'job-b'); await poll(); },
    dispose() { context.BossTracker.reader.dispose(); }
  };
}

test('full manifest mounts one isolated host and never changes business nodes; disposal releases controls', async () => {
  const h = await harness();
  assert.equal(h.document.querySelectorAll('#boss-helper-floating').length, 1);
  assert.match(h.document.getElementById('boss-helper-floating').getAttribute('style'), /left:970px!important;top:360px!important/);
  assert.match(h.document.getElementById('boss-helper-floating').getAttribute('style'), /width:42px!important;height:42px!important/);
  assert.equal(h.document.getElementById('boss-helper-floating').shadowRoot, null);
  const clone = h.document.cloneNode(true); clone.getElementById('boss-helper-floating').remove();
  assert.equal(clone.toString(), h.businessBefore);
  assert.deepEqual(h.storage.data, {});
  assert.equal(h.controls().contact.hidden, false);
  assert.equal(h.controls().contact.textContent, '标记已查看');
  assert.equal(h.controls().undo.hidden, true);
  assert.equal(h.controls().strip.hidden, true);
  vm.runInContext(source('content.js'), h.context); await h.poll();
  assert.equal(h.document.querySelectorAll('#boss-helper-floating').length, 1);
  assert.equal(h.reader.onMessage.handlers.length, 2);
  h.dispose();
  assert.equal(h.document.getElementById('boss-helper-floating'), null);
  assert.equal(h.reader.onMessage.handlers.length, 0);
});

test('dragging moves the ball within the viewport, persists it locally and suppresses accidental click actions', async () => {
  const h = await harness();
  const host = h.document.getElementById('boss-helper-floating');
  const { ball, strip, wrap } = h.controls();
  h.fire(wrap, 'mouseenter'); await h.idle();
  assert.equal(strip.hidden, false);
  h.pointer(ball, 'pointerdown', { clientX: 500, clientY: 400, pointerId: 3 });
  h.pointer(h.document, 'pointermove', { clientX: 420, clientY: 300, pointerId: 3 });
  assert.match(host.getAttribute('style'), /left:890px.*top:260px/);
  assert.equal(strip.hidden, true);
  h.pointer(h.document, 'pointerup', { clientX: 420, clientY: 300, pointerId: 3 });
  await h.idle();
  assert.deepEqual(h.storage.data['floating-position'], { x: 890, y: 260 });
  h.fire(ball, 'click', 1); await h.runTimers();
  assert.equal(h.calls.filter(call => call[1] === 'FLOAT_VIEW').length, 0);
  assert.equal(Object.values(h.storage.data).some(value => value?.key), false);
  h.fire(ball, 'dblclick'); await h.idle();
  assert.equal(h.calls.filter(call => call[0] === 'open').length, 0);
  h.dispose();
});

test('saved and resized ball positions stay inside the viewport and are corrected in local storage', async () => {
  const h = await harness({ position: { x: 5000, y: 5000 } });
  const host = h.document.getElementById('boss-helper-floating');
  await h.idle();
  assert.match(host.getAttribute('style'), /left:982px.*top:758px/);
  assert.deepEqual(h.storage.data['floating-position'], { x: 982, y: 758 });
  h.resize(600, 400); await h.idle();
  assert.match(host.getAttribute('style'), /left:558px.*top:358px/);
  assert.deepEqual(h.storage.data['floating-position'], { x: 558, y: 358 });
  h.dispose();
});

test('a pointer press without movement keeps single-click marking, while a failed position save is reported honestly', async () => {
  const first = await harness();
  const firstBall = first.controls().ball;
  first.pointer(firstBall, 'pointerdown', { clientX: 500, clientY: 400, pointerId: 4 });
  first.pointer(first.document, 'pointerup', { clientX: 501, clientY: 400, pointerId: 4 });
  first.fire(firstBall, 'click', 1); await first.runTimers();
  assert.equal(Object.values(first.storage.data).filter(value => value?.key).length, 1);
  first.dispose();

  const failed = await harness();
  failed.storage.fail('set');
  const failedBall = failed.controls().ball;
  failed.pointer(failedBall, 'pointerdown', { clientX: 500, clientY: 400, pointerId: 5 });
  failed.pointer(failed.document, 'pointermove', { clientX: 450, clientY: 350, pointerId: 5 });
  failed.pointer(failed.document, 'pointerup', { clientX: 450, clientY: 350, pointerId: 5 });
  await failed.idle();
  assert.match(failed.controls().feedback.textContent, /位置未保存/);
  assert.equal(failed.storage.data['floating-position'], undefined);
  assert.match(failed.document.getElementById('boss-helper-floating').getAttribute('style'), /left:920px.*top:310px/);
  failed.dispose();
});

test('floating position messages are top-frame-only, local-only and validated', async () => {
  const h = await harness();
  const read = { type: 'FLOAT_POSITION' };
  assert.equal(await h.send(read, { ...h.sender(), frameId: 1 }), undefined);
  assert.equal(await h.send(read, h.panelSender), undefined);
  assert.deepEqual((await h.send(read, h.sender())).position, null);
  for (const body of [{ x: '1', y: 2 }, { x: 1, y: NaN }, { x: -1, y: 2 }, { x: 100001, y: 2 }]) {
    assert.equal((await h.send({ type: 'FLOAT_POSITION_SET', ...body }, h.sender())).ok, false);
  }
  const saved = await h.send({ type: 'FLOAT_POSITION_SET', x: 120.4, y: 200.6 }, h.sender());
  assert.equal(saved.ok, true);
  assert.deepEqual(h.storage.data['floating-position'], { x: 120, y: 201 });
  assert.deepEqual(JSON.parse(JSON.stringify((await h.send(read, h.sender())).position)), { x: 120, y: 201 });
  assert.equal(Object.keys(h.storage.data).length, 1);
  h.dispose();
});

test('new company visit turns green, historical visit turns whole ball red', async () => {
  const first = await harness({ companyPage: true });
  assert.equal(first.page().history.state, 'first');
  assert.equal(first.controls().ball.classList.contains('red'), false);
  assert.equal(first.controls().ball.classList.contains('green'), true);
  assert.equal(first.controls().status.textContent, '本次已记录');
  assert.match(first.controls().when.textContent, /^查看：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(first.controls().ball.title, /查看：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await first.poll(); assert.equal(first.controls().ball.classList.contains('red'), false);
  const prior = await harness({ companyPage: true, prior: true });
  assert.equal(prior.controls().status.textContent, '之前看过');
  assert.equal(prior.controls().ball.classList.contains('red'), true);
  assert.equal(prior.controls().ball.classList.contains('green'), false);
  assert.equal(prior.controls().when.textContent, '查看：2026-10-01 08:00');
  first.controls().contact.click(); await first.idle();
  assert.equal(first.controls().status.textContent, '本次已沟通');
  assert.equal(first.controls().ball.classList.contains('red'), false);
  assert.equal(first.controls().ball.classList.contains('green'), true);
  assert.match(first.controls().when.textContent, /^查看：/);
  assert.equal(first.controls().contact.hidden, true);
  first.dispose(); prior.dispose();
});
test('job page for a newly recorded company stays green; an older record turns red', () => {
  const now = Date.now();
  const record = { ...company(), markedAt: new Date(now - 5000).toISOString() };
  const oldRecord = { ...record, markedAt: new Date(now - 120000).toISOString() };
  const jobPage = { kind: 'detail', detailType: 'job', source: 'job-company-link', current: company(), history: null, token: 'job:1', visitId: 'job-visit' };
  const currentVisitPage = { ...jobPage, history: { state: 'manual', visitId: 'job-visit' } };
  const sameVisit = api.floatingView(currentVisitPage, record, { key: company().key, state: 'first' });
  assert.equal(sameVisit.label, '本次已记录');
  assert.equal(sameVisit.red, false);
  assert.equal(sameVisit.green, true);
  assert.equal(sameVisit.seenAt, api.localDateTime(record.markedAt));
  assert.equal(sameVisit.quiet, true);
  assert.equal(sameVisit.canUndo, true);
  assert.equal(api.floatingView(jobPage, record, { key: company().key, state: 'first' }).canUndo, false);
  const newInNewTab = api.floatingView(jobPage, record, null);
  assert.equal(newInNewTab.label, '本次已记录');
  assert.equal(newInNewTab.red, false);
  assert.equal(newInNewTab.green, true);
  assert.equal(newInNewTab.quiet, true);
  assert.equal(newInNewTab.canUndo, false);
  const contactedFresh = api.floatingView(jobPage, { ...record, contactedAt: record.markedAt }, { key: company().key, state: 'first' });
  assert.equal(contactedFresh.label, '本次已沟通');
  assert.equal(contactedFresh.red, false);
  assert.equal(contactedFresh.green, true);
  assert.equal(contactedFresh.canUndo, false);
  const older = api.floatingView(jobPage, oldRecord, null);
  assert.equal(older.label, '之前看过');
  assert.equal(older.red, true);
  assert.equal(older.green, false);
  assert.equal(older.quiet, false);
  const contactedOlder = api.floatingView(jobPage, { ...oldRecord, contactedAt: oldRecord.markedAt }, null);
  assert.equal(contactedOlder.label, '已沟通');
  assert.equal(contactedOlder.red, true);
  assert.equal(contactedOlder.green, false);
  assert.equal(sameVisit.canView, false);
  assert.equal(contactedFresh.canView, false);
  const unrecorded = api.floatingView(jobPage, null, null);
  assert.equal(unrecorded.canView, true);
  assert.equal(unrecorded.canUndo, false);
  assert.equal(unrecorded.canContact, true);
});
test('capture view shows cumulative/session counts and expires recent success feedback', () => {
  assert.equal(api.captureView({ running: false }), null);
  const view = api.captureView({ running: true, total: 12, sessionCount: 4, added: 3, updated: 1, failed: 0, note: '已采集：产品经理', lastAt: 8000 }, 10000);
  assert.equal(view.mode, 'capture');
  assert.equal(view.label, '本页采集中');
  assert.equal(view.totalText, '12');
  assert.equal(view.countText, '4');
  assert.equal(view.recent, '已采集：产品经理');
  assert.equal(view.canView, false);
  assert.equal(view.canContact, false);
  const empty = api.captureView({ running: true, total: 0, sessionCount: 0, added: 0, updated: 0, failed: 0 }, 10000);
  assert.equal(empty.totalText, '0');
  assert.equal(empty.countText, '0');
  const expired = api.captureView({ running: true, total: 12, added: 3, updated: 1, failed: 0, note: '已采集：产品经理', lastAt: 1000 }, 10000);
  assert.equal(expired.recent, '');
  const failed = api.captureView({ running: true, total: 12, added: 3, updated: 1, failed: 2, error: '薪资待识别', lastAt: 5000 }, 10000);
  assert.equal(failed.recent, '薪资待识别');
  assert.equal(failed.recentError, true);
  const expiredFailure = api.captureView({ running: true, total: 12, added: 3, updated: 1, failed: 2, error: '薪资待识别', lastAt: 1000 }, 10000);
  assert.equal(expiredFailure.recent, '');
  assert.equal(expiredFailure.recentError, false);
  const unavailable = api.captureView({ running: true, total: null, totalError: '岗位统计读取失败', added: 0, updated: 0, failed: 0 }, 10000);
  assert.equal(unavailable.label, '采集统计读取失败');
  assert.equal(unavailable.totalText, '—');
  assert.equal(unavailable.unavailable, true);
});
test('actual floating ball switches to capture summary, pauses back to company view and does not write on click', async () => {
  const h = await harness();
  const recorded = {
    key: 'job:collection-a', url: 'https://www.zhipin.com/job_detail/collection-a.html',
    name: '产品经理', salary: '15-20K', city: '上海', experience: '3-5年', education: '本科',
    description: '负责产品需求分析与推进。', company: company(), companyName: company().name,
    source: 'visible-page', salarySource: 'visible-page',
    firstCollectedAt: '2026-11-01T00:00:00Z', lastCollectedAt: '2026-11-01T00:00:00Z'
  };
  h.storage.data[recorded.key] = recorded;
  h.storage.data['job:history-b'] = { ...recorded, key: 'job:history-b', url: 'https://www.zhipin.com/job_detail/history-b.html', firstCollectedAt: '2026-10-01T00:00:00Z', lastCollectedAt: '2026-10-01T00:00:00Z' };
  h.session.data['job-capture:7'] = {
    running: true, id: 'capture-one', startedAt: Date.now(), added: 1, updated: 0, failed: 0,
    lastToken: 'token', lastName: '产品经理', note: '已采集：产品经理', error: '', lastAt: Date.now(), keys: ['job:collection-a']
  };
  await h.poll();
  assert.equal(h.controls().ball.textContent, '1');
  assert.equal(h.controls().ball.classList.contains('capture'), true);
  assert.equal(h.controls().ball.classList.contains('red'), false);
  assert.equal(h.controls().ball.classList.contains('green'), false);
  assert.equal(h.controls().status.textContent, '本页采集中');
  assert.equal(h.controls().when.textContent, '本次已采集 1 个岗位');
  assert.match(h.controls().captureInfo.textContent, /本次新增 1 · 更新 0 · 未成功 0/);
  assert.match(h.controls().captureInfo.textContent, /累计 2 个岗位/);
  assert.match(h.controls().captureInfo.textContent, /已采集：产品经理/);
  assert.equal(h.controls().contact.hidden, true);
  assert.equal(h.controls().undo.hidden, true);
  assert.equal(h.controls().sound.hidden, true);
  h.fire(h.controls().ball, 'click', 1); await h.runTimers();
  assert.equal(h.calls.filter(call => call[1] === 'FLOAT_VIEW').length, 0);
  assert.equal(Object.keys(h.storage.data).filter(key => key.startsWith('company:')).length, 0);
  h.session.data['job-capture:7'].lastAt = Date.now() - 6000;
  await h.poll();
  assert.doesNotMatch(h.controls().captureInfo.textContent, /已采集：产品经理/);
  h.session.data['job-capture:7'].error = '薪资待识别';
  await h.poll();
  assert.match(h.controls().captureInfo.textContent, /薪资待识别/);
  assert.equal(h.controls().captureInfo.classList.contains('error'), true);
  h.session.data['job-capture:7'].running = false;
  await h.poll();
  assert.equal(h.controls().ball.textContent, '助');
  assert.equal(h.controls().ball.classList.contains('capture'), false);
  assert.equal(h.controls().captureInfo.hidden, true);
  assert.equal(h.controls().sound.hidden, false);
  h.dispose();
});
test('capture summary does not leak a failed total as zero or another tab session', async () => {
  const h = await harness();
  h.storage.data['job:collection-a'] = {
    key: 'job:collection-a', url: 'https://www.zhipin.com/job_detail/collection-a.html',
    name: '产品经理', salary: '15-20K', city: '上海', experience: '3-5年', education: '本科',
    description: '负责产品需求分析与推进。', company: company(), companyName: company().name,
    source: 'visible-page', salarySource: 'visible-page',
    firstCollectedAt: '2026-11-01T00:00:00Z', lastCollectedAt: '2026-11-01T00:00:00Z'
  };
  h.session.data['job-capture:7'] = { running: true, id: 'capture-one', added: 0, updated: 0, failed: 0, note: '', error: '', lastAt: 0 };
  h.storage.data['job:broken'] = { key: 'job:broken' };
  await h.poll();
  assert.equal(h.controls().ball.textContent, '—');
  assert.equal(h.controls().ball.classList.contains('unknown'), true);
  assert.equal(h.controls().status.textContent, '采集统计读取失败');
  assert.match(h.controls().captureInfo.textContent, /累计数读取失败/);
  delete h.storage.data['job:broken'];
  h.session.data['job-capture:7'].running = false;
  h.session.data['job-capture:8'] = { running: true, id: 'other', added: 1, updated: 0, failed: 0, note: '', error: '', lastAt: 0 };
  await h.poll();
  assert.equal(h.controls().ball.classList.contains('capture'), false);
  assert.equal(h.controls().ball.textContent, '助');
  h.dispose();
});
test('capture mode neither plays nor defers a company alert', async () => {
  const h = await harness();
  h.storage.data['company:' + company().key] = { ...company(), markedAt: '2026-10-01T00:00:00Z' };
  h.session.data['job-capture:7'] = { running: true, id: 'capture-one', added: 0, updated: 0, failed: 0, note: '', error: '', lastAt: 0 };
  await h.poll();
  assert.equal(h.controls().ball.classList.contains('capture'), true);
  assert.equal(h.audio.starts, 0);
  h.session.data['job-capture:7'].running = false;
  await h.poll();
  assert.equal(h.controls().ball.classList.contains('red'), true);
  assert.equal(h.audio.starts, 0);
  h.dispose();
});
test('floating status treats a new record as green and an older record as red', async () => {
  const h = await harness();
  const markedAt = new Date().toISOString();
  h.storage.data[api.PREFIX + company().key] = { ...company(), markedAt };
  await h.poll();
  assert.equal(h.controls().status.textContent, '本次已记录');
  assert.equal(h.controls().ball.classList.contains('green'), true);
  assert.equal(h.controls().ball.classList.contains('red'), false);
  h.storage.data[api.PREFIX + company().key].markedAt = '2026-10-01T00:00:00Z';
  await h.poll();
  assert.equal(h.controls().status.textContent, '之前看过');
  assert.equal(h.controls().ball.classList.contains('green'), false);
  assert.equal(h.controls().ball.classList.contains('red'), true);
  h.dispose();
});
test('status read survives BOSS same-document URL drift without masking stale company data', async () => {
  const h = await harness({ prior: true });
  const payload = h.payload('FLOAT_STATUS');
  const staleSender = { ...h.sender(), url: 'https://www.zhipin.com/web/geek/jobs?city=old' };
  h.tab.status = 'loading';
  const drifted = await h.send({ ...payload, href: 'https://www.zhipin.com/web/geek/jobs?query=old' }, staleSender);
  assert.equal(drifted.ok, true);
  assert.equal(drifted.view.label, '之前看过');
  assert.equal(drifted.view.red, true);
  h.tab.status = 'complete';
  const staleToken = await h.send({ ...payload, token: 'stale' }, h.sender());
  assert.equal(staleToken.ok, true);
  assert.equal(staleToken.view.red, true);
  const staleKey = await h.send({ ...payload, key: company(ID_B).key }, h.sender());
  assert.equal(staleKey.ok, false);
  assert.equal(staleKey.code, 'FLOAT_STATUS_RETRY');
  assert.match(staleKey.error, /自动重试/);
  const staleDocument = await h.send(payload, { ...h.sender(), documentId: 'wrong-doc' });
  assert.equal(staleDocument.ok, false);
  assert.equal(staleDocument.code, 'FLOAT_STATUS_RETRY');
  h.dispose();
});
test('status retry uses a non-alarming label while contact writes keep their current-page guards', async () => {
  const h = await harness({ prior: true });
  const original = h.reader.sendMessage;
  h.reader.sendMessage = message => message.type === 'FLOAT_STATUS'
    ? Promise.resolve({ ok: false, code: 'FLOAT_STATUS_RETRY', error: '页面正在更新，稍后自动重试。' })
    : original(message);
  h.fire(h.controls().wrap, 'mouseenter'); await h.idle();
  assert.equal(h.controls().status.textContent, '页面正在更新，稍后自动重试');
  assert.equal(h.controls().ball.classList.contains('red'), false);
  h.reader.sendMessage = original;
  const forged = await h.send({ ...h.payload('FLOAT_CONTACT'), href: company().url }, h.sender());
  assert.equal(forged.ok, false);
  assert.match(forged.error, /页面已切换/);
  const staleSender = await h.send(h.payload('FLOAT_CONTACT'), { ...h.sender(), url: 'https://www.zhipin.com/web/geek/jobs?city=old' });
  assert.equal(staleSender.ok, true);
  assert.equal(Object.values(h.storage.data)[0].key, company().key);
  h.dispose();
});
test('hover only expands; explicit contact deduplicates clicks and updates the shared repository without losing history', async () => {
  const h = await harness({ prior: true }); const { wrap, strip, contact } = h.controls();
  h.fire(wrap, 'mouseenter'); await h.idle();
  assert.equal(strip.hidden, false);
  assert.equal(Object.values(h.storage.data)[0].contactedAt, undefined);
  contact.click(); contact.click(); await h.idle();
  const saved = Object.values(h.storage.data)[0];
  assert.equal(saved.markedAt, '2026-10-01T00:00:00Z'); assert.equal(saved.rest, 'single');
  assert.equal(saved.contactSource, 'manual');
  assert.equal(h.calls.filter(call => call[1] === 'FLOAT_CONTACT').length, 1);
  assert.equal((await h.send({ type: 'RECORDS' })).records[0].contactedAt, saved.contactedAt);
  h.fire(wrap, 'mouseleave'); assert.equal(strip.hidden, true);
  h.dispose();
});

test('new job view creates a green record, then the same strip action marks contact; cancellation keeps it green', async () => {
  const h = await harness();
  assert.equal(h.controls().contact.textContent, '标记已查看');
  h.controls().contact.click(); await h.idle();
  assert.equal(Object.values(h.storage.data).length, 1);
  const viewed = Object.values(h.storage.data)[0];
  assert.equal(viewed.contactedAt, undefined);
  assert.equal(h.controls().status.textContent, '本次已记录');
  assert.equal(h.controls().ball.classList.contains('green'), true);
  assert.equal(h.controls().ball.classList.contains('red'), false);
  assert.equal(h.controls().contact.hidden, false);
  assert.equal(h.controls().contact.textContent, '标记已沟通');
  assert.equal(h.controls().undo.hidden, false);
  assert.equal(h.controls().undo.textContent, '撤销本次记录');
  h.controls().contact.click(); await h.idle();
  assert.ok(Object.values(h.storage.data)[0].contactedAt);
  assert.equal(h.controls().status.textContent, '本次已沟通');
  assert.equal(h.controls().undo.hidden, true);
  await h.send({ type: 'CANCEL_CONTACTED', key: company().key }); await h.poll();
  assert.equal(h.controls().status.textContent, '本次已记录');
  assert.equal(h.controls().ball.classList.contains('green'), true);
  assert.equal(h.controls().ball.classList.contains('red'), false);
  await h.navigateB();
  assert.equal(h.page().current.key, company(ID_B).key);
  assert.equal(h.controls().ball.classList.contains('red'), false);
  assert.equal(h.controls().ball.classList.contains('green'), false);
  assert.equal(h.controls().status.textContent, '未记录');
  h.dispose();
});

test('single click views an unrecorded job, a green single click only reveals undo, and double click opens without deleting', async () => {
  const h = await harness(); const { ball, undo, status, wrap } = h.controls();
  h.fire(ball, 'click', 1); await h.runTimers();
  assert.equal(Object.values(h.storage.data).length, 1);
  assert.equal(Object.values(h.storage.data)[0].contactedAt, undefined);
  assert.equal(status.textContent, '本次已记录');
  assert.equal(undo.hidden, false);
  const saved = structuredClone(h.storage.data);
  h.fire(ball, 'click', 1); await h.runTimers();
  assert.deepEqual(h.storage.data, saved);
  assert.equal(undo.hidden, false);
  h.fire(wrap, 'mouseenter'); undo.click(); await h.idle();
  assert.deepEqual(h.storage.data, {});
  assert.equal(status.textContent, '未记录');
  h.fire(ball, 'click', 1); await h.runTimers();
  assert.equal(Object.keys(h.storage.data).length, 1);
  h.fire(ball, 'click', 1); h.fire(ball, 'click', 2); h.fire(ball, 'dblclick'); await h.idle();
  assert.equal(h.calls.filter(call => call[0] === 'open').length, 1);
  assert.equal(Object.keys(h.storage.data).length, 1);
  h.dispose();
});

test('background rejects forged origins, child frames, stale documents, tokens, keys and unfocused contact writes', async () => {
  const h = await harness(); const message = h.payload('FLOAT_CONTACT');
  for (const from of [{ ...h.sender(), id: 'foreign' }, { ...h.sender(), frameId: 1 }, { ...h.sender(), url: 'https://example.com/' }, h.panelSender]) assert.equal(await h.send(message, from), undefined);
  for (const patch of [{ key: company(ID_B).key }, { token: 'stale' }, { href: company().url }, { visitId: 'stale' }]) assert.equal((await h.send({ ...message, ...patch }, h.sender())).ok, false);
  assert.equal((await h.send(message, { ...h.sender(), documentId: 'wrong-doc' })).ok, false);
  h.focus(false); assert.equal((await h.send(message, h.sender())).ok, false);
  assert.deepEqual(h.storage.data, {});
  h.dispose();
});

test('background undo removes only the current green record and rejects stale or forged requests', async () => {
  const h = await harness();
  assert.equal((await h.send(h.payload('FLOAT_VIEW'), h.sender())).ok, true);
  const message = h.payload('FLOAT_UNDO');
  for (const from of [{ ...h.sender(), id: 'foreign' }, { ...h.sender(), frameId: 1 }, { ...h.sender(), url: 'https://example.com/' }, h.panelSender]) assert.equal(await h.send(message, from), undefined);
  for (const patch of [{ key: company(ID_B).key }, { token: 'stale' }, { href: company().url }, { visitId: 'stale' }]) assert.equal((await h.send({ ...message, ...patch }, h.sender())).ok, false);
  assert.equal((await h.send(message, { ...h.sender(), documentId: 'wrong-doc' })).ok, false);
  h.focus(false); assert.equal((await h.send(message, h.sender())).ok, false);
  assert.equal(Object.keys(h.storage.data).length, 1);
  h.focus(true);
  assert.equal((await h.send(message, h.sender())).ok, true);
  assert.deepEqual(h.storage.data, {});
  assert.equal(h.session.data[api.VISIT_PREFIX + 7].state, 'suppressed');
  h.storage.data[api.PREFIX + company().key] = { ...company(), markedAt: '2026-10-01T00:00:00Z' };
  h.session.data[api.VISIT_PREFIX + 7] = { visitId: h.page().visitId, key: company().key, state: 'prior' };
  assert.equal((await h.send(h.payload('FLOAT_UNDO'), h.sender())).ok, false);
  assert.equal(Object.keys(h.storage.data).length, 1);
  h.dispose();
});

test('background records a manual view only for the active trusted job detail and never marks contact', async () => {
  const h = await harness(); const message = h.payload('FLOAT_VIEW');
  for (const from of [{ ...h.sender(), id: 'foreign' }, { ...h.sender(), frameId: 1 }, { ...h.sender(), url: 'https://example.com/' }, h.panelSender]) assert.equal(await h.send(message, from), undefined);
  for (const patch of [{ key: company(ID_B).key }, { token: 'stale' }, { href: company().url }, { visitId: 'stale' }]) assert.equal((await h.send({ ...message, ...patch }, h.sender())).ok, false);
  assert.equal((await h.send(message, { ...h.sender(), documentId: 'wrong-doc' })).ok, false);
  h.focus(false); assert.equal((await h.send(message, h.sender())).ok, false);
  assert.deepEqual(h.storage.data, {});
  h.focus(true);
  assert.equal((await h.send(message, h.sender())).ok, true);
  const record = Object.values(h.storage.data)[0];
  assert.equal(record.key, company().key);
  assert.equal(record.contactedAt, undefined);
  assert.equal(h.session.data[api.VISIT_PREFIX + 7].state, 'manual');
  assert.equal(h.session.data[api.VISIT_PREFIX + 7].key, company().key);
  h.dispose();
});

test('late company switch during repository verification cannot write old contact; failed save can retry', async () => {
  const h = await harness();
  const payload = h.payload('FLOAT_CONTACT'), from = h.sender();
  h.delayGet(async () => { await h.navigateB(); });
  assert.equal((await h.send(payload, from)).ok, false);
  assert.deepEqual(h.storage.data, {});
  h.storage.fail('set'); h.controls().contact.click(); await h.idle();
  assert.match(h.controls().feedback.textContent, /未保存/);
  assert.deepEqual(h.storage.data, {});
  h.storage.fail(null); h.controls().contact.click(); await h.idle();
  assert.equal(Object.values(h.storage.data)[0].key, company(ID_B).key);
  h.dispose();
});

test('company undo keeps contact disabled and prevents recreating the removed record', async () => {
  const h = await harness({ companyPage: true }); const payload = h.payload('FLOAT_CONTACT');
  await h.send({ type: 'REMOVE_COMPANY', key: company().key }); await h.poll();
  assert.equal(h.controls().contact.hidden, true);
  assert.equal(h.controls().status.textContent, '本次已撤销');
  assert.equal(h.controls().ball.classList.contains('red'), false);
  assert.equal((await h.send(payload, h.sender())).ok, false);
  assert.deepEqual(h.storage.data, {}); h.dispose();
});

test('list, missing identity and query never become red or writable despite same-name saved records', async () => {
  const h = await harness({ prior: true });
  h.context.BossTracker.parsePage = () => ({ kind: 'query', nameHint: '示例公司', current: null, companies: [], unresolved: 0 });
  await h.poll();
  assert.equal(h.controls().contact.hidden, true);
  assert.equal(h.controls().ball.classList.contains('red'), false);
  assert.match(h.controls().status.textContent, /简称/);
  assert.equal((await h.send(h.payload('FLOAT_CONTACT'), h.sender())).ok, false);
  h.context.BossTracker.parsePage = () => ({ kind: 'list', current: null, companies: [company()], unresolved: 0 });
  await h.poll(); assert.equal(h.controls().contact.hidden, true); assert.equal(h.controls().ball.classList.contains('red'), false);
  h.dispose();
});

test('double-click opens immediately in the message gesture; panel collapse pins compact strip using modern close API', async () => {
  const h = await harness();
  h.controls().ball.click(); await h.idle(); assert.equal(h.calls.filter(call => call[0] === 'open').length, 0);
  h.fire(h.controls().ball, 'dblclick');
  assert.equal(h.calls.filter(call => call[0] === 'open').length, 1);
  await h.idle();
  const response = await h.send({ type: 'FLOAT_COLLAPSE', windowId: 3 }); await h.idle();
  assert.equal(response.ok, true); assert.equal(h.controls().strip.hidden, false);
  assert.deepEqual(h.calls.find(call => call[0] === 'close')[1], { tabId: 7 });
  assert.deepEqual(h.calls.filter(call => call[0] === 'close').map(call => call[1]), [{ tabId: 7 }, { windowId: 3 }]);
  h.fire(h.controls().wrap, 'mouseleave'); assert.equal(h.controls().strip.hidden, false);
  assert.equal(h.calls.filter(call => call[1] === 'FLOAT_CONTACT').length, 0);
  assert.equal(await h.send({ type: 'FLOAT_COLLAPSE', windowId: 3 }, h.sender()), undefined);
  h.dispose();
});

test('global side panel closes through the window fallback when tab close is rejected', async () => {
  const h = await harness({ closeImpl(options) { if (options.tabId) throw new Error('The global side panel cannot be closed by tab'); } });
  h.calls.length = 0;
  const result = await h.send({ type: 'FLOAT_COLLAPSE', windowId: 3 }); await h.idle();
  assert.equal(result.ok, true);
  assert.equal(h.controls().strip.hidden, false);
  assert.deepEqual(h.calls.filter(call => call[0] === 'close').map(call => call[1]), [{ tabId: 7 }, { windowId: 3 }]);
  h.dispose();
});

test('collapse reports an honest retained-strip error when neither side panel close succeeds', async () => {
  const h = await harness({ closeImpl() { throw new Error('not allowed'); } });
  h.calls.length = 0;
  const result = await h.send({ type: 'FLOAT_COLLAPSE', windowId: 3 }); await h.idle();
  assert.equal(result.ok, false);
  assert.match(result.error, /侧栏未能关闭.*悬浮条已保留/);
  assert.equal(h.controls().strip.hidden, false);
  assert.equal(h.calls.filter(call => call[0] === 'close').length, 2);
  h.dispose();
});

test('older Chrome collapse disables then restores the same tab side panel without navigating BOSS', async () => {
  const h = await harness({ closeAPI: false }); h.calls.length = 0;
  assert.equal((await h.send({ type: 'FLOAT_COLLAPSE', windowId: 3 })).ok, true);
  const options = h.calls.filter(call => call[0] === 'options').map(call => call[1]);
  assert.deepEqual(options, [{ tabId: 7, enabled: false }, { tabId: 7, path: 'panel.html', enabled: true }]);
  assert.equal(h.controls().strip.hidden, false);
  assert.equal(h.tab.url, 'https://www.zhipin.com/web/geek/job'); h.dispose();
});

test('missing compact receiver gives structured recovery action and never closes or injects silently', async () => {
  const h = await harness(); h.dispose(); h.calls.length = 0;
  const result = await h.send({ type: 'FLOAT_COLLAPSE', windowId: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FLOAT_RECONNECT_REQUIRED');
  assert.match(result.error, /重新读取并收起/);
  assert.doesNotMatch(result.error, /Receiving end/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.target)), { tabId: 7, href: h.tab.url });
  assert.equal(h.calls.some(call => ['close', 'options'].includes(call[0])), false);
  assert.deepEqual(h.storage.data, {});
});

test('collapse recovery refuses changed target and does not mistake unrelated transport failure for missing reader', async () => {
  const h = await harness(); h.calls.length = 0;
  assert.equal((await h.send({ type: 'FLOAT_COLLAPSE', windowId: 3, tabId: 8, href: h.tab.url })).ok, false);
  h.chrome.tabs.sendMessage = async () => { throw new Error('The message port closed before a response was received.'); };
  const result = await h.send({ type: 'FLOAT_COLLAPSE', windowId: 3 });
  assert.equal(result.ok, false); assert.equal(result.code, undefined);
  assert.match(result.error, /侧栏已保留/);
  assert.equal(h.calls.some(call => ['close', 'options'].includes(call[0])), false);
  h.dispose();
});

test('actual floating sound is tied to red status, does not repeat on hover/poll/compact and stops on dispose', async () => {
  const first = await harness({ companyPage: true });
  assert.equal(first.audio.starts, 0);
  first.controls().contact.click(); await first.idle(); assert.equal(first.audio.starts, 0);
  first.storage.data['company:' + company().key].markedAt = '2026-10-01T00:00:00Z';
  await first.poll(); assert.equal(first.audio.starts, 0, 'quiet contact alert is consumed for this encounter');
  await first.poll(); first.fire(first.controls().wrap, 'mouseenter'); await first.idle();
  await first.send({ type: 'FLOAT_COLLAPSE', windowId: 3 }); await first.idle();
  assert.equal(first.audio.starts, 0);
  first.dispose(); assert.equal(first.audio.closes, 0);
  const prior = await harness({ prior: true }); assert.equal(prior.audio.starts, 1);
  prior.dispose(); assert.equal(prior.audio.closes, 1);
});

test('blocked playback shows explicit enable button; rejected unlock remains honest and retryable', async () => {
  const h = await harness({ prior: true, audioState: 'suspended' });
  assert.equal(h.audio.starts, 0); assert.equal(h.controls().unlock.textContent, '启用声音');
  h.audio.rejected = true; h.controls().unlock.click(); await h.idle();
  assert.equal(h.audio.starts, 0); assert.equal(h.controls().unlock.textContent, '重试启用声音');
  assert.match(h.controls().soundStatus.textContent, /尚未启用/);
  h.audio.rejected = false; h.controls().unlock.click(); await h.idle();
  assert.equal(h.audio.starts, 1); assert.equal(h.controls().sound.textContent, '提示音：开');
  assert.equal(h.controls().unlock.hidden, true); h.dispose();
});

test('sound preference is separate from company data, persists through remount and failed writes do not claim success', async () => {
  const h = await harness({ prior: true }); const saved = structuredClone(h.storage.data['company:' + company().key]);
  h.controls().sound.click(); await h.idle();
  assert.equal(h.storage.data['sound-enabled'], false);
  assert.equal(h.controls().sound.textContent, '提示音：关');
  assert.deepEqual(h.storage.data['company:' + company().key], saved);
  const records = (await h.send({ type: 'RECORDS' })).records; assert.equal(records.length, 1);
  h.storage.fail('set'); h.controls().sound.click(); await h.idle();
  assert.match(h.controls().feedback.textContent, /设置未保存/);
  assert.equal(h.storage.data['sound-enabled'], false);
  h.storage.fail(null); await h.poll(); assert.equal(h.controls().sound.textContent, '提示音：关');
  h.dispose(); vm.runInContext(source('content.js'), h.context); await h.idle();
  assert.equal(h.controls().sound.textContent, '提示音：关'); assert.equal(h.audio.starts, 1);
  h.dispose();
});

test('preference writes reject foreign/child/stale sources and invalid values; unfocused tabs cannot sound', async () => {
  const h = await harness();
  const payload = { ...h.payload('FLOAT_SOUND_SET'), enabled: false };
  assert.equal(await h.send(payload, { ...h.sender(), frameId: 1 }), undefined);
  assert.equal(await h.send(payload, h.panelSender), undefined);
  assert.equal((await h.send({ ...payload, enabled: 'false' }, h.sender())).ok, false);
  assert.equal((await h.send({ ...payload, token: 'old' }, h.sender())).ok, false);
  h.focus(false); h.controls().contact.click(); await h.idle(); assert.equal(h.audio.starts, 0);
  h.dispose();
});

test('blocked sound can still be muted without unlocking audio or altering the company record', async () => {
  const h = await harness({ prior: true, audioState: 'suspended' });
  assert.equal(h.controls().unlock.hidden, false);
  h.controls().sound.click(); await h.idle();
  assert.equal(h.controls().sound.textContent, '提示音：关');
  assert.equal(h.controls().unlock.hidden, true);
  assert.equal(h.audio.resumes, 0); assert.equal(h.audio.starts, 0);
  assert.equal(h.storage.data['sound-enabled'], false);
  assert.equal((await h.send({ type: 'RECORDS' })).records.length, 1); h.dispose();
});
