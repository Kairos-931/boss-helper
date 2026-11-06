import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { api, company, memoryStorage } from './helpers.js';
const source = path => readFileSync(new URL(`../extension/${path}`, import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
function event() {
  const handlers = [];
  return { handlers, addListener(fn) { handlers.push(fn); }, removeListener(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); } };
}
function harness({ companyPage = false, absent = false } = {}) {
  const storage = memoryStorage(); const session = memoryStorage(); const intervals = new Map();
  const counters = { observers: 0, injections: 0, auto: 0 };
  const tab = { id: 7, windowId: 3, active: true, status: 'complete', url: companyPage ? company().url : 'https://www.zhipin.com/web/geek/job' };
  let documentId = 'document-one'; let runtime; let failure = null; let injectHook = null; let focused = true; let responseHook = null; let autoReplyHook = null;
  const { document, window } = parseHTML(companyPage ? '<html><div class="company-info"><h1>甲公司</h1></div></html>' : readFileSync(new URL('fixtures/inline-detail.html', import.meta.url), 'utf8'));
  const original = document.toString();
  let timerId = 0;
  class Observer { constructor() { this.active = false; } observe() { this.active = true; counters.observers++; } disconnect() { if (this.active) { this.active = false; counters.observers--; } } }
  const context = vm.createContext({ document, URL, Date, console, location: { get href() { return tab.url; } }, crypto: { randomUUID: () => `reader-${++timerId}` }, MutationObserver: Observer,
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout(fn) { const id = ++timerId; Promise.resolve().then(fn); return id; }, clearTimeout() {} });
  const chrome = {
    runtime: { id: 'extension', onMessage: event(), onInstalled: event(), onStartup: event() }, storage: { local: { ...storage, async setAccessLevel() {} }, session },
    sidePanel: { async setOptions() {}, async setPanelBehavior() {} },
    windows: { async get() { return { focused }; } },
    tabs: { onRemoved: event(), onUpdated: event(), onCreated: event(), async get() { return { ...tab }; }, async query() { return [{ ...tab }]; },
      async sendMessage(id, msg, options) {
        if (id !== tab.id || (options?.documentId && options.documentId !== documentId)) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (failure) throw new Error(failure);
        if (!runtime || runtime.invalid) throw new Error('Could not establish connection. Receiving end does not exist.');
        let answered = false; let value;
        for (const fn of [...runtime.onMessage.handlers]) fn(msg, { id: 'extension' }, result => { if (!answered) { answered = true; value = result; } });
        if (!answered) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (responseHook) { const hook = responseHook; responseHook = null; await hook(msg); }
        return structuredClone(value);
      } },
    scripting: { async executeScript(options) {
      counters.injections++;
      assert.deepEqual(JSON.parse(JSON.stringify(options.target)), { tabId: 7, frameIds: [0] });
      assert.equal(options.world, 'ISOLATED');
      if (injectHook) await injectHook();
      installRuntime();
      let result; for (const path of options.files) result = vm.runInContext(source(path), context);
      return [{ frameId: 0, documentId, result: structuredClone(result) }];
    } }
  };
  const background = vm.createContext({ chrome, URL, Date, Intl, console });
  background.importScripts = (...paths) => { for (const path of paths) vm.runInContext(source(path), background); };
  vm.runInContext(source('background.js'), background);
  const send = (msg, sender = { id: 'extension', url: 'chrome-extension://extension/panel.html' }) => new Promise(resolve => {
    if (!chrome.runtime.onMessage.handlers[0](msg, sender, resolve)) resolve(undefined);
  });
  function installRuntime() {
    runtime = { invalid: false, get id() { return this.invalid ? undefined : 'extension'; }, onMessage: event(), async sendMessage(msg) {
      if (this.invalid) throw new Error('Extension context invalidated.');
      if (msg.type === 'AUTO_COMPANY_VISIT') counters.auto++;
      const reply = await send(msg, { id: 'extension', frameId: 0, documentId, tab: { ...tab }, url: tab.url });
      if (msg.type === 'AUTO_COMPANY_VISIT' && autoReplyHook) { const hook = autoReplyHook; autoReplyHook = null; await hook(); }
      return reply;
    } };
    context.chrome = { runtime };
  }
  if (!absent) { installRuntime(); for (const path of ['core/identity.js', 'core/parser.js', 'core/page-state.js', 'content.js']) vm.runInContext(source(path), context); }
  const read = () => send({ type: 'READ_PAGE', tabId: 7, windowId: 3, href: tab.url });
  return { storage, session, chrome, context, tab, counters, document, original, send, read,
    poll() { for (const fn of [...intervals.values()]) fn(); },
    activeIntervals() { return intervals.size; }, listeners() { return runtime?.onMessage.handlers.length || 0; },
    invalidate() { runtime.invalid = true; },
    eraseSingleton() { context.BossTracker?.reader?.dispose(); delete context.BossTracker?.reader; },
    failure(value) { failure = value; }, focus(value) { focused = value; },
    injectHook(fn) { injectHook = fn; }, responseHook(fn) { responseHook = fn; },
    delayAuto(fn) { autoReplyHook = fn; },
    directInject() { for (const path of ['core/identity.js', 'core/parser.js', 'core/page-state.js', 'recovery-begin.js', 'content.js']) vm.runInContext(source(path), context); },
    navigate(href) { tab.url = href; }, documentId(value) { documentId = value; }
  };
}
test('healthy/unknown read uses no injection; content/source/window/domain boundaries and transport errors are honest', async () => {
  const h = harness(); await flush();
  assert.equal((await h.read()).recovered, false); assert.equal(h.counters.injections, 0);
  h.document.querySelector('.job-detail').removeAttribute('data-job-id');
  assert.equal((await h.read()).snapshot.current, null); assert.equal(h.counters.injections, 0);
  for (const sender of [{ id: 'foreign', url: 'chrome-extension://extension/panel.html' }, { id: 'extension', tab: { id: 7 }, url: h.tab.url }, { id: 'extension', url: 'chrome-extension://extension/other.html' }]) assert.equal(await h.send({ type: 'READ_PAGE' }, sender), undefined);
  for (const patch of [{ href: 'https://example.com' }, { windowId: 9 }]) assert.equal((await h.send({ type: 'READ_PAGE', tabId: 7, windowId: 3, href: h.tab.url, ...patch })).ok, false);
  h.focus(false); assert.equal((await h.read()).ok, false); h.focus(true);
  h.tab.status = 'loading'; assert.equal((await h.read()).ok, false); h.tab.status = 'complete';
  h.failure('The message port closed before a response was received.'); assert.equal((await h.read()).ok, false); assert.equal(h.counters.injections, 0);
});

test('absent reader collapse waits for explicit read, restores once and only then closes into the compact strip', async () => {
  const h = harness({ companyPage: true, absent: true }); let closed = 0;
  h.chrome.sidePanel.close = async () => { closed++; };
  const collapse = () => h.send({ type: 'FLOAT_COLLAPSE', windowId: 3 });
  const missing = await collapse();
  assert.equal(missing.code, 'FLOAT_RECONNECT_REQUIRED');
  assert.equal(h.counters.injections, 0); assert.equal(closed, 0);
  assert.equal((await h.read()).ok, true); await flush();
  assert.equal(h.counters.injections, 1);
  assert.ok(h.document.getElementById('boss-helper-floating'));
  assert.equal((await collapse()).ok, true);
  assert.equal(closed, 2); assert.equal(h.counters.injections, 1);
  assert.deepEqual(h.storage.data, {}, 'uncertain recovered company visit must not auto-write');
});
test('missing connection restores once, uses document binding and repeated injection keeps one reader with untouched DOM', async () => {
  const h = harness(); await flush(); const first = (await h.read()).snapshot;
  h.invalidate(); const result = await h.read(); await flush();
  assert.equal(result.ok, true); assert.equal(result.recovered, true); assert.equal(result.snapshot.visitId, first.visitId);
  assert.equal(h.counters.injections, 1); assert.equal(h.counters.observers, 1); assert.equal(h.activeIntervals(), 1); assert.equal(h.listeners(), 2);
  h.directInject(); h.directInject(); await flush();
  assert.equal(h.counters.observers, 1); assert.equal(h.activeIntervals(), 1); assert.equal(h.listeners(), 2);
  assert.equal((await h.read()).recovered, false); assert.equal(h.counters.injections, 1);
  const business = h.document.cloneNode(true);
  assert.ok(business.getElementById('boss-helper-floating'));
  business.getElementById('boss-helper-floating').remove();
  assert.equal(business.toString(), h.original); assert.deepEqual(h.storage.data, {});
});
test('company same-document recovery retains first time and suppression; lost singleton restores verified session', async () => {
  const h = harness({ companyPage: true }); await flush();
  const first = (await h.read()).snapshot;
  assert.equal(first.history.state, 'first'); const time = Object.values(h.storage.data)[0].markedAt;
  h.invalidate(); assert.equal((await h.read()).snapshot.history.state, 'first'); await flush();
  assert.equal(Object.values(h.storage.data)[0].markedAt, time);
  await h.send({ type: 'REMOVE_COMPANY', key: company().key }); await flush();
  h.invalidate(); h.eraseSingleton();
  const restored = await h.read(); await flush();
  assert.equal(restored.snapshot.history.state, 'suppressed'); assert.equal(restored.snapshot.visitId, first.visitId);
  h.poll(); await flush(); await h.read(); await flush(); assert.deepEqual(h.storage.data, {});
  h.navigate('https://www.zhipin.com/job_detail/left.html'); h.poll(); await flush();
  h.navigate(company().url); h.poll(); await flush(); assert.equal(Object.keys(h.storage.data).length, 1);
});
test('unknown recovered company visit never writes on polling/reopening/re-reading; only genuine reentry releases block', async () => {
  const h = harness({ companyPage: true, absent: true });
  const result = await h.read(); await flush();
  assert.equal(result.ok, true); assert.equal(result.snapshot.history.recoveryBlocked, true);
  assert.match(result.snapshot.history.error, /状态无法确认/); assert.deepEqual(h.storage.data, {});
  h.poll(); h.poll(); await h.read(); await flush();
  assert.deepEqual(h.storage.data, {}); assert.equal(h.counters.auto, 0); assert.equal(h.counters.injections, 1);
  const current = await h.chrome.tabs.sendMessage(7, { type: 'GET_PAGE' });
  assert.equal((await h.chrome.tabs.sendMessage(7, { type: 'RETRY_VISIT' })).retrying, false);
  h.invalidate(); h.eraseSingleton(); await h.read(); await flush();
  assert.equal((await h.read()).snapshot.history.recoveryBlocked, true); assert.deepEqual(h.storage.data, {});
  h.navigate('https://www.zhipin.com/job_detail/left.html'); h.poll(); await flush();
  h.navigate(company().url); h.poll(); await flush();
  assert.equal(Object.keys(h.storage.data).length, 1); assert.notEqual((await h.read()).snapshot.visitId, current.visitId);
});
test('recovery retains local history and undo does not cause re-save when original session was missing', async () => {
  const h = harness({ companyPage: true, absent: true });
  h.storage.data[api.PREFIX + company().key] = { ...company(), markedAt: '2026-10-01T00:00:00Z' };
  const result = await h.read(); await flush();
  assert.equal(result.snapshot.history.state, 'prior'); assert.equal(result.snapshot.history.recoveryBlocked, true);
  await h.send({ type: 'REMOVE_COMPANY', key: company().key }); await flush(); h.poll(); await flush();
  assert.equal((await h.read()).snapshot.history.state, 'suppressed'); assert.deepEqual(h.storage.data, {});
});
test('navigation/response/injection errors cannot publish old company and concurrent reads do not inject twice', async () => {
  const h = harness({ absent: true }); let release;
  const gate = new Promise(resolve => { release = resolve; }); h.injectHook(() => gate);
  const pending = h.read(); await flush();
  assert.equal((await h.read()).ok, false); assert.equal(h.counters.injections, 1);
  h.navigate('https://example.com'); release(); assert.equal((await pending).ok, false); assert.deepEqual(h.storage.data, {});
  const failed = harness({ absent: true }); failed.injectHook(() => { throw new Error('Permission denied'); });
  assert.match((await failed.read()).error, /Permission denied/); assert.match((await failed.read()).error, /Permission denied/);
  assert.equal(failed.counters.injections, 2, 'one attempt per click, no background retry');
  const stale = harness(); await flush(); stale.responseHook(() => stale.navigate('https://example.com'));
  assert.equal((await stale.read()).ok, false); assert.equal(stale.counters.injections, 0);
});

test('old invalid runtime late result cannot overwrite resumed suppression and poll disposes resources', async () => {
  const h = harness({ companyPage: true }); let release;
  const gate = new Promise(resolve => { release = resolve; }); h.delayAuto(() => gate); await flush();
  assert.equal(Object.keys(h.storage.data).length, 1);
  await h.send({ type: 'REMOVE_COMPANY', key: company().key }); await flush();
  h.invalidate(); h.poll(); assert.equal(h.activeIntervals(), 0); assert.equal(h.counters.observers, 0);
  assert.equal((await h.read()).snapshot.history.state, 'suppressed');
  release(); await flush();
  assert.equal((await h.read()).snapshot.history.state, 'suppressed'); assert.deepEqual(h.storage.data, {});
  assert.equal(h.activeIntervals(), 1); assert.equal(h.counters.observers, 1);
});
test('same URL in another document cannot reuse first-visit session and does not reset original first time', async () => {
  const h = harness({ companyPage: true }); await flush();
  const time = Object.values(h.storage.data)[0].markedAt;
  h.invalidate(); h.eraseSingleton(); h.documentId('different-document');
  const result = await h.read(); await flush();
  assert.equal(result.snapshot.history.state, 'prior'); assert.equal(result.snapshot.history.recoveryBlocked, true);
  assert.equal(Object.values(h.storage.data)[0].markedAt, time);
});
test('session failure after injection remains read-only; next explicit read resumes without another injection', async () => {
  const h = harness({ companyPage: true, absent: true }); h.session.fail('set');
  assert.equal((await h.read()).ok, false); assert.equal(h.counters.injections, 1); assert.deepEqual(h.storage.data, {});
  h.poll(); await flush(); assert.deepEqual(h.storage.data, {});
  h.session.fail(null);
  assert.equal((await h.read()).snapshot.history.recoveryBlocked, true);
  assert.equal(h.counters.injections, 1); assert.deepEqual(h.storage.data, {});
});
