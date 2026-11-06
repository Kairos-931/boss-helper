import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { api, company, ID_A, ID_B, memoryStorage } from './helpers.js';
const source = path => readFileSync(new URL(`../extension/${path}`, import.meta.url), 'utf8');
function event() {
  const handlers = [];
  return { addListener(fn) { handlers.push(fn); }, emit(...args) { for (const fn of handlers) fn(...args); }, handlers };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function setup() {
  const storage = memoryStorage();
  const session = memoryStorage();
  const changed = event();
  const tab = { id: 7, active: true, windowId: 3, url: 'https://www.zhipin.com/job_detail/one.html', status: 'complete' };
  let current = company();
  let kind = 'detail';
  let companies = [];
  let unresolved = 0;
  let detailType = 'job';
  let pageSource = 'job-company-link';
  let history = null;
  let focused = true;
  let jobSubject = 'job:one';
  let beforeResponse = null;
  const page = api.createPageState(() => ({ kind, current, companies, unresolved, detailType, subject: jobSubject, source: detailType === 'company' ? 'company-page' : pageSource, reason: '缺少唯一公司链接' }), () => tab.url, 'test-document');
  let snapshot = page.refresh();
  const local = {
    ...storage,
    async setAccessLevel() {},
    async set(value) { await storage.set(value); changed.emit(Object.fromEntries(Object.entries(value).map(([key, newValue]) => [key, { newValue }])), 'local'); },
    async remove(key) { await storage.remove(key); changed.emit({ [key]: {} }, 'local'); }
  };
  const onMessage = event();
  const chrome = {
    runtime: { id: 'test-extension', onInstalled: event(), onStartup: event(), onMessage, getManifest: () => ({ version: '0.5.1' }) },
    storage: { local, session, onChanged: changed },
    sidePanel: { async setPanelBehavior() {}, async setOptions() {} },
    windows: { async getCurrent() { return { id: 3 }; }, async get() { return { id: 3, focused }; } },
    tabs: {
      onUpdated: event(), onActivated: event(), onRemoved: event(), onCreated: event(),
      async query() { return [{ ...tab }]; },
      async get(id) { if (id !== tab.id) throw new Error('No tab'); return { ...tab }; },
      async sendMessage(id, msg) {
        if (id !== tab.id) throw new Error('No tab');
        if (msg.type === 'CONFIRM_COMPANY') return page.confirm(msg.token, msg.key);
        if (msg.type === 'CONFIRM_VISIT') return page.confirmVisit(msg.token, msg.key, msg.visitId);
        if (msg.type === 'CONFIRM_MANUAL') return page.confirmManual(msg.token, msg.key, msg.visitId);
        if (msg.type === 'CONFIRM_LIST_CLICK') {
          const confirmed = page.confirmListClick(msg.token, msg.key, msg.visitId, msg.jobKey);
          return confirmed ? { ...confirmed, documentId: 'test-document' } : null;
        }
        if (msg.type === 'VISIT_RESULT') { history = msg.history; onMessage.emit({ type: 'PAGE_CHANGED' }, { id: chrome.runtime.id, tab: { id: tab.id } }); return { updated: true }; }
        if (msg.type === 'RETRY_VISIT') { await auto(); return { retrying: true }; }
        if (msg.type === 'GET_PAGE') {
          snapshot = page.refresh();
          const returned = structuredClone({ ...snapshot, history: history?.visitId === snapshot.visitId ? history : null });
          if (beforeResponse) { const hook = beforeResponse; beforeResponse = null; await hook(); }
          return returned;
        }
      }
    }
  };
  const context = vm.createContext({ chrome, URL, Date, Intl, console });
  context.importScripts = (...paths) => { for (const path of paths) vm.runInContext(source(path), context); };
  vm.runInContext(source('background.js'), context);
  const backgroundListener = onMessage.handlers[0];
  function send(msg, sender = { id: 'test-extension', url: 'chrome-extension://test-extension/panel.html' }) {
    return new Promise(resolve => {
      const accepted = backgroundListener(msg, sender, resolve);
      if (!accepted) resolve(undefined);
    });
  }
  chrome.runtime.sendMessage = send;
  async function auto(snapshot = page.refresh(), sender = { id: 'test-extension', frameId: 0, tab: { ...tab }, url: tab.url }) {
    const result = await send({ type: 'AUTO_COMPANY_VISIT', token: snapshot.token, visitId: snapshot.visitId, key: snapshot.current?.key, href: snapshot.href }, sender);
    if (result?.ok) history = result.history;
    else if (result && !result.inactive) history = { state: 'error', visitId: snapshot.visitId, error: result.error };
    return result;
  }
  return {
    chrome, storage, session, tab, page, send, auto, focus(value) { focused = value; },
    async companyPage(value = company(), href = value.url) {
      current = value; kind = 'detail'; detailType = 'company'; tab.url = href; page.refresh();
      const result = await auto();
      chrome.tabs.onUpdated.emit(tab.id, { url: tab.url }, { ...tab });
      return result;
    },
    navigate(value = company(ID_B), href = 'https://www.zhipin.com/job_detail/two.html') {
      current = value; kind = 'detail'; detailType = 'job'; pageSource = 'job-company-link'; jobSubject = api.jobIdentity(href) || value?.key || ''; tab.url = href; page.refresh();
      chrome.tabs.onUpdated.emit(tab.id, { url: tab.url }, { ...tab });
    },
    inline(value = company(), jobKey = 'job:one', href = 'https://www.zhipin.com/web/geek/job') {
      current = value; kind = 'detail'; detailType = 'job'; pageSource = 'job-card-match'; jobSubject = jobKey; tab.url = href; page.refresh();
      chrome.tabs.onUpdated.emit(tab.id, { url: tab.url }, { ...tab });
      return page.refresh();
    },
    list(values, unknown = 0) { kind = 'list'; detailType = 'job'; current = null; companies = values; unresolved = unknown; tab.url = 'https://www.zhipin.com/web/geek/job'; page.refresh(); chrome.tabs.onUpdated.emit(tab.id, { url: tab.url }, { ...tab }); },
    delayNext(hook) { beforeResponse = hook; }
  };
}
async function panel(env, options = {}) {
  const { document } = parseHTML(source('panel.html'));
  const blobs = [];
  class TestURL extends URL {}
  TestURL.createObjectURL = blob => { blobs.push(blob); return 'blob:test-export'; };
  TestURL.revokeObjectURL = () => {};
  const intervals = [];
  const context = vm.createContext({
    chrome: env.chrome, document, Blob, URL: TestURL, Date, Intl, console, navigator: { clipboard: options.clipboard || { async writeText() {} } }, crypto: { randomUUID: () => `panel-${Math.random()}` }, addEventListener() {}, innerHeight: 800,
    setInterval(fn) { intervals.push(fn); return intervals.length; }, setTimeout() { return 1; }
  });
  for (const file of ['core/identity.js', 'core/rest.js', 'core/settings.js', 'core/page-state.js', 'core/records.js', 'core/visits.js', 'core/pad.js', 'pad.js']) vm.runInContext(source(file), context);
  const code = source('panel.js').replace(/^import .*;\r?\n/gm, '');
  await vm.runInContext(`(async () => { ${code}\n })()`, context);
  await flush();
  return { document, blobs, intervals, click(selector) { const node = document.querySelector(selector); assert.ok(node, `Missing ${selector}`); assert.equal(node.disabled, false); node.click(); } };
}

test('dashboard extension tab can read records through actual background; other tab origins and writes remain blocked', async () => {
  const env = setup();
  await env.send({ type: 'MARK_CONTACTED', ...company() });
  const dashboard = { id: 'test-extension', url: 'chrome-extension://test-extension/dashboard.html', tab: { id: 42 } };
  const result = await env.send({ type: 'RECORDS' }, dashboard);
  assert.equal(result.ok, true); assert.equal(result.records.length, 1);
  const jobs = await env.send({ type: 'JOBS_SUMMARY' }, dashboard);
  assert.equal(jobs.ok, true); assert.equal(jobs.total, 0);
  assert.equal(await env.send({ type: 'REMOVE_COMPANY', key: company().key }, dashboard), undefined);
  assert.equal(await env.send({ type: 'PAD_READ' }, dashboard), undefined);
  for (const sender of [{ ...dashboard, url: 'https://www.zhipin.com/' }, { ...dashboard, url: 'chrome-extension://test-extension/other.html' }, { ...dashboard, id: 'foreign' }, { ...dashboard, url: 'chrome-extension://test-extension/dashboard.html?other' }]) {
    assert.equal(await env.send({ type: 'RECORDS' }, sender), undefined);
    assert.equal(await env.send({ type: 'JOBS_SUMMARY' }, sender), undefined);
  }
  assert.equal((await env.send({ type: 'RECORDS' })).records.length, 1);
});

test('panel offers explicit read-and-collapse after disconnection, then retries only after successful read', async () => {
  const env = setup(); let connected = false; const actions = [];
  const original = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = async (id, msg, options) => {
    if (msg.type === 'FLOAT_COMPACT') {
      actions.push('compact');
      if (!connected) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { shown: true };
    }
    return original(id, msg, options);
  };
  env.chrome.sidePanel.close = async () => { actions.push('close'); };
  const send = env.chrome.runtime.sendMessage;
  env.chrome.runtime.sendMessage = async msg => {
    actions.push(msg.type);
    const result = await send(msg);
    if (msg.type === 'READ_PAGE' && result?.ok) connected = true;
    return result;
  };
  const p = await panel(env); actions.length = 0;
  p.click('#collapse-floating'); await flush();
  assert.match(p.document.getElementById('feedback').textContent, /重新读取并收起/);
  assert.equal(p.document.getElementById('retry').textContent, '重新读取并收起');
  assert.equal(p.document.getElementById('retry').hidden, false);
  assert.equal(actions.includes('READ_PAGE'), false); assert.equal(actions.includes('close'), false);
  p.click('#retry'); p.click('#retry'); await flush();
  assert.equal(actions.filter(action => action === 'READ_PAGE').length, 1);
  assert.equal(actions.filter(action => action === 'close').length, 2);
  assert.ok(actions.indexOf('READ_PAGE') < actions.lastIndexOf('compact'));
  assert.deepEqual(env.storage.data, {});
});

test('failed explicit recovery retains panel and offers retry without sending another collapse', async () => {
  const env = setup(); const actions = [];
  const original = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = async (id, msg, options) => {
    if (msg.type === 'FLOAT_COMPACT') throw new Error('Could not establish connection. Receiving end does not exist.');
    return original(id, msg, options);
  };
  const send = env.chrome.runtime.sendMessage;
  env.chrome.runtime.sendMessage = async msg => {
    actions.push(msg.type);
    return msg.type === 'READ_PAGE' ? { ok: false, error: '模拟恢复失败' } : send(msg);
  };
  env.chrome.sidePanel.close = async () => { actions.push('close'); };
  const p = await panel(env); actions.length = 0;
  p.click('#collapse-floating'); await flush();
  p.click('#retry'); await flush();
  assert.match(p.document.getElementById('feedback').textContent, /模拟恢复失败/);
  assert.equal(p.document.getElementById('retry').textContent, '重新读取并收起');
  assert.equal(actions.filter(action => action === 'FLOAT_COLLAPSE').length, 1);
  assert.equal(actions.includes('close'), false);
});
test('copy-collapse switch defaults off, persists and collapses only after a successful copy', async () => {
  const env = setup(); const actions = [];
  const original = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = async (id, msg, options) => {
    if (msg.type === 'FLOAT_COMPACT') { actions.push('compact'); return { shown: true }; }
    return original(id, msg, options);
  };
  env.chrome.sidePanel.close = async () => { actions.push('close'); };
  const send = env.chrome.runtime.sendMessage;
  env.chrome.runtime.sendMessage = async msg => { actions.push(msg.type); return send(msg); };
  const ui = await panel(env);
  const toggle = ui.document.getElementById('pad-collapse');
  const field = ui.document.getElementById('pad-text');
  assert.equal(toggle.checked, false);
  field.value = '复制后收起侧栏'; field.dispatchEvent(new ui.document.defaultView.Event('input')); await flush();
  ui.click('#pad-copy'); await flush();
  assert.equal(actions.includes('FLOAT_COLLAPSE'), false);
  toggle.checked = true; toggle.dispatchEvent(new ui.document.defaultView.Event('change')); await flush();
  assert.equal(env.storage.data[api.PAD_COLLAPSE_KEY], true);
  actions.length = 0;
  ui.click('#pad-copy'); await flush();
  assert.ok(actions.includes('FLOAT_COLLAPSE'));
  assert.ok(actions.indexOf('compact') < actions.indexOf('close'));
  assert.equal(env.storage.data[api.PAD_KEY].text, '复制后收起侧栏');
  const reopened = await panel(env);
  assert.equal(reopened.document.getElementById('pad-collapse').checked, true);
});
test('copy-collapse switch leaves the sidebar open on copy or setting failure', async () => {
  const env = setup(); const actions = [];
  const original = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = async (id, msg, options) => {
    if (msg.type === 'FLOAT_COMPACT') { actions.push('compact'); return { shown: true }; }
    return original(id, msg, options);
  };
  env.chrome.sidePanel.close = async () => { actions.push('close'); };
  const send = env.chrome.runtime.sendMessage;
  env.chrome.runtime.sendMessage = async msg => { actions.push(msg.type); return send(msg); };
  const ui = await panel(env, { clipboard: { async writeText() { throw new Error('denied'); } } });
  const toggle = ui.document.getElementById('pad-collapse');
  const field = ui.document.getElementById('pad-text');
  field.value = '复制会失败'; field.dispatchEvent(new ui.document.defaultView.Event('input')); await flush();
  toggle.checked = true; toggle.dispatchEvent(new ui.document.defaultView.Event('change')); await flush();
  actions.length = 0;
  ui.click('#pad-copy'); await flush();
  assert.equal(actions.includes('FLOAT_COLLAPSE'), false);
  assert.match(ui.document.getElementById('pad-copy-status').textContent, /复制失败/);

  const failedEnv = setup(); failedEnv.storage.fail('set');
  const failed = await panel(failedEnv);
  const failedToggle = failed.document.getElementById('pad-collapse');
  failedToggle.checked = true; failedToggle.dispatchEvent(new failed.document.defaultView.Event('change')); await flush();
  assert.equal(failedToggle.checked, false);
  assert.match(failed.document.getElementById('pad-collapse-status').textContent, /开关未保存.*再切换/);
  failedEnv.storage.fail(null);
  failedToggle.checked = true; failedToggle.dispatchEvent(new failed.document.defaultView.Event('change')); await flush();
  assert.equal(failedToggle.checked, true);
  assert.equal(failedEnv.storage.data[api.PAD_COLLAPSE_KEY], true);
  assert.equal(failed.document.getElementById('pad-collapse-status').textContent, '');
});
function manualMessage(env, snapshot = env.page.refresh()) {
  return { type: 'MARK_JOB_COMPANY', tabId: env.tab.id, windowId: env.tab.windowId, href: snapshot.href, token: snapshot.token, visitId: snapshot.visitId, key: snapshot.current?.key };
}
function listClickMessage(env, snapshot = env.page.refresh()) {
  return {
    type: 'LIST_CARD_VIEW',
    href: snapshot.href,
    token: snapshot.token,
    visitId: snapshot.visitId,
    jobKey: snapshot.jobKey,
    key: snapshot.current?.key,
    name: snapshot.current?.name,
    url: snapshot.current?.url
  };
}
function listClickSender(env) {
  return { id: 'test-extension', frameId: 0, tab: { ...env.tab }, url: env.tab.url, documentId: 'test-document' };
}
test('list-click keeps existing behavior off, then records one confirmed inline card as viewed only', async () => {
  const env = setup();
  const snapshot = env.inline(company(), 'job:list-a');
  const message = listClickMessage(env, snapshot);
  assert.equal((await env.send(message, listClickSender(env))).disabled, true);
  assert.deepEqual(env.storage.data, {});

  env.storage.data[api.LIST_CLICK_VIEW_KEY] = true;
  const first = await env.send(message, listClickSender(env));
  assert.equal(first.ok, true);
  assert.equal(first.recorded, true);
  assert.equal(first.history.state, 'manual');
  const stored = env.storage.data[api.PREFIX + company().key];
  assert.equal(stored.contactedAt, undefined);
  assert.equal(stored.contactSource, undefined);
  const firstTime = stored.markedAt;

  const repeated = await env.send(message, listClickSender(env));
  assert.equal(repeated.recorded, true);
  assert.equal(repeated.history.state, 'manual');
  assert.equal(env.storage.data[api.PREFIX + company().key].markedAt, firstTime);

  assert.equal(await env.send(message, { id: 'test-extension', url: 'chrome-extension://test-extension/panel.html' }), undefined);
  assert.equal(await env.send(message, { ...listClickSender(env), frameId: 1 }), undefined);
  const wrongJob = await env.send({ ...message, jobKey: 'job:list-b' }, listClickSender(env));
  assert.equal(wrongJob.ok, false);
  assert.equal((await env.send({ ...message, key: company(ID_B).key, name: company(ID_B).name, url: company(ID_B).url }, listClickSender(env))).ok, false);

  env.navigate(company(), 'https://www.zhipin.com/job_detail/list-b.html');
  const sourceMismatch = listClickMessage(env);
  assert.equal((await env.send(sourceMismatch, listClickSender(env))).ok, false);
  env.inline(company(), 'job:list-a');
  env.focus(false);
  assert.equal((await env.send(listClickMessage(env), listClickSender(env))).ok, false);
  env.focus(true);
  env.tab.url = company().url;
  assert.equal(await env.send(listClickMessage(env), listClickSender(env)), undefined);
  assert.equal(Object.keys(env.storage.data).filter(key => key.startsWith(api.PREFIX)).length, 1);
});
test('list-click setting is independent, defaults off, persists through panel reopen and reports save failure', async () => {
  const env = setup();
  const first = await panel(env);
  const toggle = first.document.getElementById('list-click-view');
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggle.dispatchEvent(new first.document.defaultView.Event('change'));
  await flush();
  assert.equal(env.storage.data[api.LIST_CLICK_VIEW_KEY], true);
  assert.equal(Object.keys(env.storage.data).filter(key => key.startsWith(api.PREFIX)).length, 0);
  const reopened = await panel(env);
  assert.equal(reopened.document.getElementById('list-click-view').checked, true);

  const failed = setup();
  failed.storage.fail('set');
  const ui = await panel(failed);
  const failedToggle = ui.document.getElementById('list-click-view');
  failedToggle.checked = true;
  failedToggle.dispatchEvent(new ui.document.defaultView.Event('change'));
  await flush();
  assert.equal(failedToggle.checked, false);
  assert.match(ui.document.getElementById('list-click-view-status').textContent, /开关未保存.*再切换/);
  failed.storage.fail(null);
  failedToggle.checked = true;
  failedToggle.dispatchEvent(new ui.document.defaultView.Event('change'));
  await flush();
  assert.equal(failed.storage.data[api.LIST_CLICK_VIEW_KEY], true);
  assert.equal(ui.document.getElementById('list-click-view-status').textContent, '');
});
test('background name repair re-reads evidence, refuses untrusted/stale pages and never creates or recreates a company', async () => {
  const env = setup();
  const original = { ...company(undefined, '示例公司收藏'), markedAt: '2026-10-01T00:00:00Z' };
  env.storage.data[api.PREFIX + original.key] = original;
  const sendPage = env.chrome.tabs.sendMessage;
  let proof = true; let reads = 0;
  env.chrome.tabs.sendMessage = async (id, msg, options) => {
    const result = await sendPage(id, msg, options);
    if (msg.type === 'GET_PAGE' && result.current && proof) { result.current.nameProof = { kind: 'name-node', name: result.current.name }; reads++; }
    return result;
  };
  const snapshot = env.page.refresh();
  const msg = { type: 'SYNC_COMPANY_NAMES', tabId: 7, windowId: 3, href: snapshot.href, token: snapshot.token, name: '不要信任请求名称' };
  for (const sender of [{ id: 'foreign', url: 'chrome-extension://test-extension/panel.html' }, { id: 'test-extension', url: 'chrome-extension://test-extension/other.html' }, { id: 'test-extension', tab: { id: 7 }, url: env.tab.url }]) assert.equal(await env.send(msg, sender), undefined);
  assert.equal((await env.send({ ...msg, token: 'old' })).ok, false);
  env.tab.active = false; assert.equal((await env.send(msg)).ok, false); env.tab.active = true;
  env.delayNext(async () => env.navigate()); assert.equal((await env.send(msg)).ok, false);
  assert.deepEqual(env.storage.data[api.PREFIX + original.key], original);
  env.navigate(company(), 'https://www.zhipin.com/job_detail/three.html');
  const next = { ...msg, token: env.page.refresh().token, href: env.tab.url };
  proof = false; assert.equal((await env.send(next)).updated, 0);
  proof = true; env.storage.fail('set'); assert.equal((await env.send(next)).ok, false); env.storage.fail(null);
  assert.deepEqual(env.storage.data[api.PREFIX + original.key], original);
  assert.equal((await env.send(next)).updated, 1); assert.ok(reads >= 2);
  assert.deepEqual(env.storage.data[api.PREFIX + original.key], { ...original, name: company().name });
  await env.send({ type: 'REMOVE_COMPANY', key: original.key });
  assert.equal((await env.send(next)).updated, 0); assert.deepEqual(env.storage.data, {});
});
test('panel updates proven historical name once from current evidence, synchronizing records/search/CSV without marking job viewed again', async () => {
  const env = setup();
  const original = { ...company(undefined, '示例公司收藏'), markedAt: '2026-10-01T00:00:00Z' };
  env.storage.data[api.PREFIX + original.key] = original;
  const sendPage = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = async (id, msg, options) => {
    const result = await sendPage(id, msg, options);
    if (msg.type === 'GET_PAGE' && result.current) result.current.nameProof = { kind: 'filtered-link', name: result.current.name };
    return result;
  };
  const ui = await panel(env); await flush();
  assert.equal(Object.keys(env.storage.data).length, 1); assert.equal(env.storage.data[api.PREFIX + original.key].markedAt, original.markedAt);
  assert.equal(env.storage.data[api.PREFIX + original.key].name, company().name);
  assert.doesNotMatch(ui.document.getElementById('record-list').textContent, /收藏/);
  assert.equal(ui.document.getElementById('page-badge').textContent, '之前已看过');
  const search = ui.document.getElementById('search'); search.value = '收藏'; search.dispatchEvent(new ui.document.defaultView.Event('input'));
  assert.match(ui.document.getElementById('record-list').textContent, /没有匹配/);
  ui.click('#export'); await flush();
  assert.doesNotMatch(await ui.blobs[0].text(), /收藏|nameProof/); assert.match(await ui.blobs[0].text(), /2026-10-01T00:00:00Z/);
});
test('re-read button updates normally, reports errors, releases busy state and leaves pad and records intact', async () => {
  const env = setup(); const ui = await panel(env);
  const field = ui.document.getElementById('pad-text'); field.value = '话术保持'; field.dispatchEvent(new ui.document.defaultView.Event('input')); await flush();
  const before = structuredClone(env.storage.data); let injections = 0;
  env.chrome.scripting = { async executeScript() { injections++; throw new Error('permission denied'); } };
  ui.click('#reconnect'); await flush();
  assert.equal(ui.document.getElementById('reconnect').disabled, false);
  assert.match(ui.document.getElementById('feedback').textContent, /已重新读取/);
  assert.equal(injections, 0); assert.equal(field.value, '话术保持'); assert.deepEqual(env.storage.data, before);
  env.navigate(null); await flush(); ui.click('#reconnect'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '无法识别'); assert.equal(injections, 0);
  const original = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
  ui.click('#reconnect'); await flush();
  assert.equal(injections, 1); assert.match(ui.document.getElementById('feedback').textContent, /permission denied/);
  assert.equal(ui.document.getElementById('reconnect').disabled, false);
  ui.intervals[0](); await flush(); assert.equal(injections, 1, 'polling never performs recovery injection');
  env.chrome.tabs.sendMessage = original; ui.click('#reconnect'); await flush(); assert.equal(ui.document.getElementById('reconnect').disabled, false);
});
test('re-read button serializes rapid clicks and rejects page change during pending response', async () => {
  const env = setup(); const ui = await panel(env); let release;
  const gate = new Promise(resolve => { release = resolve; }); let reads = 0;
  const original = env.chrome.tabs.sendMessage;
  env.chrome.tabs.sendMessage = async (id, msg, options) => { if (msg.type === 'GET_PAGE') { reads++; const value = await original(id, msg, options); await gate; return value; } return original(id, msg, options); };
  ui.click('#reconnect'); await flush();
  assert.equal(ui.document.getElementById('reconnect').disabled, true);
  ui.document.getElementById('reconnect').click(); await flush(); assert.equal(reads, 1);
  env.navigate(company(ID_B), 'https://example.com'); release(); await flush();
  assert.equal(ui.document.getElementById('reconnect').disabled, false);
  assert.match(ui.document.getElementById('feedback').textContent, /重新读取失败/);
  assert.doesNotMatch(ui.document.getElementById('page-content').textContent, /示例公司/);
  assert.deepEqual(env.storage.data, {});
});
test('records collapse to recent three, search ignores collapse, clear resets and CSV exports all without pad', async () => {
  const env = setup();
  for (let i = 0; i < 6; i++) {
    const value = company(`record-company-${i}`, `测试公司${i}`);
    env.storage.data[api.PREFIX + value.key] = { ...value, markedAt: `2026-10-0${i + 1}T00:00:00Z` };
  }
  await env.send({ type: 'PAD_SAVE', text: '仅属于私人话术', height: 160, revision: 0, writer: 'fixture', sequence: 1 });
  const ui = await panel(env); const list = ui.document.getElementById('record-list');
  assert.equal(list.querySelectorAll('li').length, 3);
  assert.match(list.textContent, /测试公司5/); assert.doesNotMatch(list.textContent, /测试公司0/);
  assert.equal(ui.document.getElementById('record-count').textContent, '6');
  assert.equal(ui.document.getElementById('records-toggle').textContent, '展开全部（6）');
  ui.click('#records-toggle'); assert.equal(list.querySelectorAll('li').length, 6);
  ui.click('#records-toggle'); assert.equal(list.querySelectorAll('li').length, 3);
  const search = ui.document.getElementById('search');
  search.value = '测试公司'; search.dispatchEvent(new ui.document.defaultView.Event('input'));
  assert.equal(list.querySelectorAll('li').length, 6);
  assert.equal(ui.document.getElementById('records-toggle').hidden, true);
  search.value = '测试公司0'; search.dispatchEvent(new ui.document.defaultView.Event('input'));
  assert.match(list.textContent, /测试公司0/);
  search.value = ''; search.dispatchEvent(new ui.document.defaultView.Event('input'));
  assert.equal(list.querySelectorAll('li').length, 3);
  ui.click('#export'); await flush();
  const csv = await ui.blobs[0].text();
  for (let i = 0; i < 6; i++) assert.match(csv, new RegExp(`测试公司${i}`));
  assert.doesNotMatch(csv, /私人话术/);
  ui.click('.undo'); await flush();
  assert.equal(ui.document.getElementById('record-count').textContent, '5');
  assert.equal(list.querySelectorAll('li').length, 3);
  assert.equal(ui.document.getElementById('records-toggle').textContent, '展开全部（5）');
  const field = ui.document.getElementById('pad-text');
  assert.equal(field.value, '仅属于私人话术');
  field.value = '真实面板输入联调'; field.dispatchEvent(new ui.document.defaultView.Event('input')); await flush();
  assert.equal(env.storage.data[api.PAD_KEY].text, '真实面板输入联调');
  assert.equal(ui.document.getElementById('pad-status').textContent, '');
  env.navigate(); env.chrome.storage.onChanged.emit({ [api.PREFIX + company().key]: {} }, 'local'); await flush();
  assert.equal(field.value, '真实面板输入联调');
  const reopened = await panel(env);
  assert.equal(reopened.document.getElementById('pad-text').value, '真实面板输入联调');
});
test('zero to three records need no expansion; pad messages accept only trusted panel context', async () => {
  for (let count = 0; count <= 3; count++) {
    const env = setup();
    for (let i = 0; i < count; i++) {
      const value = company(`small-company-${i}`);
      env.storage.data[api.PREFIX + value.key] = { ...value, markedAt: '2026-10-11T00:00:00Z' };
    }
    const ui = await panel(env);
    assert.equal(ui.document.getElementById('record-list').querySelectorAll('li').length, count);
    assert.equal(ui.document.getElementById('records-toggle').hidden, true);
    for (const sender of [{ id: 'foreign', url: 'chrome-extension://test-extension/panel.html' }, { id: 'test-extension', tab: { id: 7 }, url: env.tab.url }, { id: 'test-extension', url: 'chrome-extension://test-extension/other.html' }]) {
      assert.equal(await env.send({ type: 'PAD_READ' }, sender), undefined);
      assert.equal(await env.send({ type: 'PAD_SAVE', text: '伪造' }, sender), undefined);
    }
  }
});
test('manual click saves once, remains green/current after events and another recent job page', async () => {
  const env = setup(); const ui = await panel(env);
  assert.deepEqual(env.storage.data, {});
  assert.equal(ui.document.querySelector('.mark').textContent, '标记已查看');
  ui.click('.mark'); await flush();
  assert.equal(Object.keys(env.storage.data).length, 1);
  const firstTime = Object.values(env.storage.data)[0].markedAt;
  assert.equal(ui.document.getElementById('page-badge').textContent, '已记录本次查看');
  assert.equal(ui.document.querySelectorAll('.history-warning').length, 0);
  assert.equal((await env.send(manualMessage(env))).history.state, 'manual');
  env.chrome.storage.onChanged.emit({ [api.PREFIX + company().key]: {} }, 'local'); ui.intervals[0](); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '已记录本次查看');
  const reopened = await panel(env);
  assert.equal(reopened.document.getElementById('page-badge').textContent, '已记录本次查看', 'same detail survives panel reopening');
  env.navigate(); env.navigate(company(), 'https://www.zhipin.com/job_detail/three.html'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '本次已记录');
  assert.doesNotMatch(ui.document.getElementById('page-content').textContent, /这家公司你之前看过/);
  assert.match(ui.document.getElementById('page-content').textContent, new RegExp(api.localDate(firstTime)));
  assert.ok(ui.document.getElementById('page-content').textContent.includes(api.localDateTime(firstTime)));
  assert.equal(ui.document.getElementById('page-content').closest('section').classList.contains('history-warning'), false);
  assert.equal(Boolean(ui.document.getElementById('record-list').closest('.history-warning')), false);
  assert.equal((await env.send(manualMessage(env))).history.state, 'prior');
  assert.equal(Object.values(env.storage.data)[0].markedAt, firstTime);
  env.list([company(), company(ID_B)]); await flush();
  assert.equal(Boolean(ui.document.querySelector('.mark')), false);
  assert.equal(ui.document.querySelectorAll('.history-warning').length, 0);
  assert.match(source('panel.css'), /\.history-warning\s*\{[^}]*background:\s*#fff1f2/);
  assert.match(source('panel.css'), /\.history-warning \.company, \.history-message\s*\{[^}]*color:\s*#8c252f/);
});
test('manual write failure is retryable; undo stays empty until another explicit click', async () => {
  const env = setup(); const ui = await panel(env);
  env.storage.fail('set'); ui.click('.mark'); await flush();
  assert.deepEqual(env.storage.data, {});
  assert.equal(ui.document.getElementById('page-badge').textContent, '未记录');
  assert.match(ui.document.getElementById('feedback').textContent, /保存失败/);
  env.storage.fail(null); ui.click('#retry'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '已记录本次查看');
  ui.click('.undo'); await flush(); ui.intervals[0](); await flush();
  assert.deepEqual(env.storage.data, {});
  assert.match(ui.document.getElementById('page-content').textContent, /本次已撤销/);
  ui.click('.mark'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '已记录本次查看');
  assert.equal(Object.keys(env.storage.data).length, 1);
});
test('manual source guard refuses content/foreign pages, stale identities and background windows', async () => {
  const env = setup(); const msg = manualMessage(env);
  for (const sender of [
    { id: 'foreign', url: 'chrome-extension://test-extension/panel.html' },
    { id: 'test-extension', tab: { ...env.tab }, frameId: 0, url: env.tab.url },
    { id: 'test-extension', url: 'chrome-extension://test-extension/other.html' }
  ]) assert.equal(await env.send(msg, sender), undefined);
  for (const patch of [{ token: 'old' }, { visitId: 'old' }, { key: company(ID_B).key }, { windowId: 99 }, { href: company().url }]) {
    assert.equal((await env.send({ ...msg, ...patch })).ok, false);
  }
  env.tab.active = false; assert.equal((await env.send(msg)).ok, false);
  env.tab.active = true; env.focus(false); assert.equal((await env.send(msg)).ok, false);
  env.focus(true); env.navigate(); assert.equal((await env.send(msg)).ok, false);
  env.navigate(null); assert.equal((await env.send(manualMessage(env))).ok, false);
  env.list([company()]); assert.equal((await env.send(manualMessage(env))).ok, false);
  assert.deepEqual(env.storage.data, {});
});
test('manual request revalidates after storage read and after content response, preventing A/B race', async () => {
  for (const trigger of ['storage-read', 'content-response']) {
    const env = setup(); const msg = manualMessage(env);
    if (trigger === 'storage-read') {
      const original = env.chrome.storage.local.get;
      env.chrome.storage.local.get = async key => { const result = await original(key); env.navigate(); return result; };
    } else {
      const original = env.chrome.tabs.sendMessage;
      env.chrome.tabs.sendMessage = async (id, request) => {
        const result = await original(id, request);
        if (request.type === 'CONFIRM_MANUAL') env.navigate();
        return result;
      };
    }
    assert.equal((await env.send(msg)).ok, false, trigger);
    assert.deepEqual(env.storage.data, {}, trigger);
  }
});
test('background rejects job/manual/untrusted auto writes and revalidates active company page token', async () => {
  const env = setup();
  assert.equal(await env.send({ type: 'RECORDS' }, { id: 'foreign', url: 'chrome-extension://test-extension/panel.html' }), undefined);
  assert.equal(await env.send({ type: 'RECORDS' }, { id: 'test-extension', tab: { id: 7 }, url: env.tab.url }), undefined);
  assert.equal(await env.auto(), undefined, 'job URL must not be authorized to record');
  assert.equal(await env.send({ type: 'MARK_COMPANY', tabId: 7 }), undefined, 'obsolete manual write route removed');
  await env.companyPage();
  const snapshot = env.page.refresh();
  await env.send({ type: 'REMOVE_COMPANY', key: company().key });
  env.navigate();
  const stale = await env.auto(snapshot, { id: 'test-extension', frameId: 0, tab: { ...env.tab }, url: snapshot.href });
  assert.equal(stale.ok, false);
  assert.deepEqual(env.storage.data, {});
  const saved = await env.companyPage(company(ID_B));
  assert.equal(saved.ok, true);
  assert.equal(await env.auto(env.page.refresh(), { id: 'test-extension', frameId: 1, tab: { ...env.tab }, url: env.tab.url }), undefined);
  env.tab.active = false;
  assert.equal((await env.auto()).ok, false);
  env.tab.active = true; env.focus(false);
  assert.equal((await env.auto()).inactive, true);
});
test('company jobs tab URL is authorized and records with canonical company identity', async () => {
  const env = setup();
  const jobsHref = `https://www.zhipin.com/gongsi/job/${ID_A}.html`;
  const result = await env.companyPage(company(), jobsHref);
  assert.equal(result.ok, true);
  assert.equal(result.history.state, 'first');
  assert.equal(result.history.href, jobsHref);
  const saved = env.storage.data[api.PREFIX + company().key];
  assert.equal(saved.url, company().url);
  assert.equal(saved.name, company().name);
  assert.equal(saved.markedAt, result.history.markedAt);
});
test('job page keeps a just-recorded company framed as this visit, not prior history', async () => {
  const env = setup();
  const ui = await panel(env);
  await env.companyPage();
  await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '首次查看，已记录');
  env.navigate(company(), 'https://www.zhipin.com/job_detail/same-company.html');
  await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '本次已记录');
  assert.equal(ui.document.getElementById('page-content').closest('section').classList.contains('history-warning'), false);
});
test('side panel integration: job never records; company auto visits work without panel; search/CSV/undo remain', async () => {
  const env = setup(); const ui = await panel(env);
  assert.equal(ui.document.getElementById('page-badge').textContent, '未记录');
  assert.deepEqual(env.storage.data, {});
  assert.ok(ui.document.querySelector('.mark'));
  await env.companyPage(); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '首次查看，已记录');
  assert.equal(ui.document.getElementById('record-count').textContent, '1');
  const input = ui.document.getElementById('search'); input.value = '不存在'; input.dispatchEvent(new ui.document.defaultView.Event('input'));
  assert.match(ui.document.getElementById('record-list').textContent, /没有匹配/);
  input.value = ''; input.dispatchEvent(new ui.document.defaultView.Event('input'));
  ui.click('#export'); await flush();
  assert.equal(ui.blobs.length, 1);
  assert.equal((await ui.blobs[0].arrayBuffer()).byteLength > 0, true);
  const bytes = new Uint8Array(await ui.blobs[0].arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [239, 187, 191]);
  assert.match(await ui.blobs[0].text(), /示例公司/);
  ui.click('.undo'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '本次已撤销');
  assert.deepEqual(env.storage.data, {});
  await env.auto(); ui.intervals[0](); await flush();
  assert.deepEqual(env.storage.data, {}, 'current visit must remain suppressed');
  env.navigate(); await env.companyPage(); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '首次查看，已记录');
});
test('cancelling from first company visits and freshly marked jobs restores their original view state', async () => {
  for (const detailType of ['company', 'job']) {
    const env = setup();
    const ui = await panel(env);
    if (detailType === 'company') await env.companyPage();
    else ui.click('.mark');
    await flush();
    const viewedState = ui.document.getElementById('page-badge').textContent;
    const firstViewed = env.storage.data[api.PREFIX + company().key].markedAt;
    ui.click('.mark-contacted'); await flush();
    assert.equal(ui.document.getElementById('page-badge').textContent, '本次已沟通', detailType);
    ui.click('.cancel-contacted'); await flush();
    assert.equal(ui.document.getElementById('page-badge').textContent, viewedState, detailType);
    assert.equal(env.storage.data[api.PREFIX + company().key].markedAt, firstViewed, detailType);
    assert.equal(ui.document.getElementById('record-count').textContent, '1');
  }
});

test('current page contact button appears only for reliable identities and updates shared records', async () => {
  const env = setup();
  const ui = await panel(env);
  await env.companyPage(); await flush();
  const firstViewed = env.storage.data[api.PREFIX + company().key].markedAt;
  ui.click('#page-content .secondary'); await flush();
  assert.equal(env.storage.data[api.PREFIX + company().key].contactSource, 'manual');
  assert.equal(env.storage.data[api.PREFIX + company().key].markedAt, firstViewed);
  assert.equal(ui.document.getElementById('page-badge').textContent, '本次已沟通');
  assert.equal(ui.document.querySelector('#page-content .secondary'), null);
  assert.ok(ui.document.querySelector('#record-list .cancel-contacted'));
  await env.send({ type: 'CANCEL_CONTACTED', key: company().key }); await flush();
  ui.click('.undo'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '本次已撤销');
  assert.equal(ui.document.querySelector('#page-content .secondary'), null, 'suppressed company visit must not offer contact marking');
  env.list([company()]); await flush();
  assert.equal(ui.document.querySelector('#page-content .secondary'), null, 'list pages must not offer contact marking');
});

test('unrecorded job detail can mark contacted directly and create the viewed record', async () => {
  const env = setup();
  const ui = await panel(env);
  assert.deepEqual(env.storage.data, {});
  assert.ok(ui.document.querySelector('#page-content .mark'));
  ui.click('#page-content .secondary'); await flush();
  const record = env.storage.data[api.PREFIX + company().key];
  assert.equal(record.contactSource, 'manual');
  assert.equal(record.contactedAt, record.markedAt);
  assert.equal(ui.document.getElementById('page-badge').textContent, '本次已沟通');
  assert.equal(ui.document.querySelector('#page-content .mark'), null);
  assert.equal(ui.document.querySelector('#page-content .secondary'), null);
});

test('panel cancellation failure keeps contact and pad, retry updates CSV and explicit remark/undo still work', async () => {
  const env = setup();
  const original = { ...company(), markedAt: '2026-10-01T00:00:00Z', contactedAt: '2026-11-01T01:00:00Z', contactSource: 'auto', rest: 'single-double', restUpdatedAt: '2026-10-02T00:00:00Z' };
  env.storage.data[api.PREFIX + original.key] = original;
  const ui = await panel(env);
  const pad = ui.document.getElementById('pad-text');
  pad.value = '取消沟通不影响话术';
  pad.dispatchEvent(new ui.document.defaultView.Event('input'));
  await flush();
  const before = structuredClone(env.storage.data);
  env.storage.fail('set');
  ui.click('.cancel-contacted'); await flush();
  assert.deepEqual(env.storage.data, before);
  assert.equal(ui.document.getElementById('page-badge').textContent, '已沟通');
  assert.match(ui.document.getElementById('feedback').textContent, /取消沟通失败/);
  assert.equal(ui.document.querySelector('.cancel-contacted').disabled, false);
  env.storage.fail(null);
  ui.click('#retry'); await flush();
  const expected = structuredClone(before);
  delete expected[api.PREFIX + original.key].contactedAt;
  delete expected[api.PREFIX + original.key].contactSource;
  assert.deepEqual(env.storage.data, expected);
  assert.equal(pad.value, '取消沟通不影响话术');
  assert.equal(ui.document.getElementById('page-badge').textContent, '之前已看过');
  assert.match(ui.document.getElementById('feedback').textContent, /已查看记录保留/);
  assert.ok(ui.document.querySelector('.rest-tag'));
  ui.click('#export'); await flush();
  const csv = await ui.blobs[0].text();
  assert.match(csv, /示例公司|2026-10-01T00:00:00Z/);
  assert.match(csv, /"","","单双休"/);
  assert.doesNotMatch(csv, /2026-11-01T01:00:00Z|"auto"/);
  ui.click('.mark-contacted'); await flush();
  assert.equal(env.storage.data[api.PREFIX + original.key].contactSource, 'manual');
  assert.equal(env.storage.data[api.PREFIX + original.key].markedAt, original.markedAt);
  ui.click('.undo'); await flush();
  assert.equal(env.storage.data[api.PREFIX + original.key], undefined);
  delete expected[api.PREFIX + original.key];
  assert.deepEqual(env.storage.data, expected);
  assert.equal(pad.value, '取消沟通不影响话术');
});

test('busy cancellation blocks repeated clicks and leaves one explicit request', async () => {
  const env = setup();
  await env.send({ type: 'MARK_CONTACTED', ...company() });
  const ui = await panel(env);
  const send = env.chrome.runtime.sendMessage;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let cancellations = 0;
  env.chrome.runtime.sendMessage = async payload => {
    if (payload.type === 'CANCEL_CONTACTED') { cancellations++; await gate; }
    return send(payload);
  };
  const button = ui.document.querySelector('.cancel-contacted');
  ui.click('.cancel-contacted');
  button.click();
  ui.document.querySelector('.cancel-contacted').click();
  assert.equal(cancellations, 1);
  assert.equal(ui.document.querySelector('.cancel-contacted').disabled, true);
  assert.equal(ui.document.querySelector('.undo').disabled, true);
  assert.equal(ui.document.getElementById('export').disabled, true);
  release(); await flush();
  assert.equal(env.storage.data[api.PREFIX + company().key].contactedAt, undefined);
  assert.ok(ui.document.querySelector('.mark-contacted'));
  assert.equal(ui.document.getElementById('record-count').textContent, '1');
});

test('a record read begun before cancellation cannot restore stale contact in the panel', async () => {
  const env = setup();
  await env.send({ type: 'MARK_CONTACTED', ...company() });
  const ui = await panel(env);
  const send = env.chrome.runtime.sendMessage;
  let release;
  let began;
  let delayed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  env.chrome.runtime.sendMessage = async payload => {
    const reply = await send(payload);
    if (payload.type === 'RECORDS' && !delayed) { delayed = true; began(); await gate; }
    return reply;
  };
  env.chrome.storage.onChanged.emit({ [api.PREFIX + company().key]: {} }, 'local');
  await started;
  ui.click('.cancel-contacted'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '本次已记录');
  release(); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '本次已记录');
  assert.ok(ui.document.querySelector('.mark-contacted'));
  assert.equal(ui.document.querySelector('.badge.contacted'), null);
});

test('side panel handles navigation during delayed response without displaying prior company', async () => {
  const env = setup(); const ui = await panel(env);
  env.delayNext(async () => env.navigate(company(ID_B, '另一家公司')));
  ui.intervals[0](); await flush();
  assert.match(ui.document.getElementById('page-content').textContent, /另一家公司/);
  assert.doesNotMatch(ui.document.getElementById('page-content').textContent, /示例公司/);
  env.navigate(null); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '无法识别');
  assert.equal(Boolean(ui.document.querySelector('.mark')), false);
  env.list([], 2); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '无法识别');
  assert.match(ui.document.getElementById('page-content').textContent, /2 个职位卡片无法识别/);
  env.navigate(null, 'https://example.com'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '未连接');
});
test('side panel automatically refreshes list matches after company auto record and undo', async () => {
  const env = setup(); const ui = await panel(env);
  await env.companyPage(); await flush();
  env.list([company(), company(ID_B, '未看公司')], 1); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '已看过 1 家');
  assert.match(ui.document.getElementById('page-content').textContent, /示例公司/);
  ui.click('.undo'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '已看过 0 家');
});
test('side panel reports company auto write/read failure honestly and retry recovers', async () => {
  const env = setup(); const ui = await panel(env);
  env.storage.fail('set'); await env.companyPage(); await flush();
  assert.match(ui.document.getElementById('page-content').textContent, /保存失败/);
  assert.equal(ui.document.getElementById('page-badge').textContent, '记录失败');
  assert.deepEqual(env.storage.data, {});
  env.storage.fail(null); ui.click('#page-content button'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '首次查看，已记录');
  env.storage.fail('get'); env.chrome.storage.onChanged.emit({ [api.PREFIX + company().key]: {} }, 'local'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '记录不可用');
  assert.equal(Boolean(ui.document.querySelector('.mark')), false);
  assert.equal(ui.document.getElementById('export').disabled, true);
  env.storage.fail(null); ui.click('#retry'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '首次查看，已记录');
});
test('content runtime publishes DOM additions automatically, exposes read-only snapshots and refuses stale confirmation', async () => {
  const markup = readFileSync(new URL('fixtures/list.html', import.meta.url), 'utf8');
  const { document, window } = parseHTML(markup);
  const notifications = [];
  const messages = event();
  const intervals = [];
  const location = { href: 'https://www.zhipin.com/web/geek/job' };
  const context = vm.createContext({
    document, location, URL, console, crypto: { randomUUID: () => 'synthetic-document' },
    chrome: { runtime: { id: 'extension-test', onMessage: messages, async sendMessage(msg) { notifications.push(msg.type); } } },
    MutationObserver: window.MutationObserver,
    addEventListener: window.addEventListener.bind(window),
    setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
    setTimeout(fn) { Promise.resolve().then(fn); return 1; }, clearTimeout() {}
  });
  const before = document.toString();
  for (const file of ['core/identity.js', 'core/parser.js', 'core/page-state.js', 'content.js']) vm.runInContext(source(file), context);
  assert.equal(document.toString(), before);
  const ask = message => new Promise(resolve => messages.handlers[0](message, { id: 'extension-test' }, resolve));
  const first = await ask({ type: 'GET_PAGE' });
  assert.equal(first.companies.length, 2);
  document.querySelector('ul').insertAdjacentHTML('beforeend', '<li class="job-card-wrapper"><a href="/gongsi/runtime-company-id.html">运行样本公司</a></li>');
  await flush();
  const after = await ask({ type: 'GET_PAGE' });
  assert.equal(after.companies.length, 3);
  assert.ok(notifications.length >= 2);
  assert.equal(await ask({ type: 'CONFIRM_COMPANY', token: first.token, key: company().key }), null);
  location.href = 'https://www.zhipin.com/job_detail/next.html';
  intervals[0]();
  assert.equal((await ask({ type: 'GET_PAGE' })).current, null);
});
test('actual content/background integration auto records only a foreground company page without an open panel', async () => {
  const env = setup();
  env.tab.url = company().url;
  const { document, window } = parseHTML('<html><head><title>合成公司页</title></head><body><div class="company-info"><h1>甲公司</h1></div></body></html>');
  const incoming = event(); const intervals = [];
  const contentChrome = {
    runtime: {
      id: 'test-extension', onMessage: incoming,
      async sendMessage(msg) { return env.send(msg, { id: 'test-extension', frameId: 0, tab: { ...env.tab }, url: env.tab.url }); }
    }
  };
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (id !== env.tab.id) throw new Error('No tab');
    return new Promise(resolve => incoming.handlers[0](msg, { id: 'test-extension' }, resolve));
  };
  const context = vm.createContext({
    document, URL, console, chrome: contentChrome, location: { get href() { return env.tab.url; } },
    crypto: { randomUUID: () => 'actual-content-fixture' }, MutationObserver: window.MutationObserver,
    addEventListener: window.addEventListener.bind(window),
    setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
    setTimeout(fn) { Promise.resolve().then(fn); return 1; }, clearTimeout() {}
  });
  const original = document.toString();
  for (const file of ['core/identity.js', 'core/parser.js', 'core/page-state.js', 'content.js']) vm.runInContext(source(file), context);
  await flush();
  assert.equal(document.toString(), original, 'auto record must not mutate website DOM');
  assert.equal(Object.keys(env.storage.data).length, 1);
  assert.equal((await env.chrome.tabs.sendMessage(7, { type: 'GET_PAGE' })).history.state, 'first');
  const firstTime = Object.values(env.storage.data)[0].markedAt;
  intervals[0](); await flush();
  assert.equal((await env.chrome.tabs.sendMessage(7, { type: 'GET_PAGE' })).history.state, 'first');
  assert.equal(Object.values(env.storage.data)[0].markedAt, firstTime);
  await env.send({ type: 'REMOVE_COMPANY', key: company().key });
  intervals[0](); await flush();
  assert.deepEqual(env.storage.data, {});
  assert.equal((await env.chrome.tabs.sendMessage(7, { type: 'GET_PAGE' })).history.state, 'suppressed');
  env.tab.url = 'https://www.zhipin.com/job_detail/another-job.html';
  intervals[0](); await flush();
  assert.deepEqual(env.storage.data, {}, 'job URL must not trigger auto record');
  env.tab.url = company().url;
  intervals[0](); await flush();
  assert.equal(Object.keys(env.storage.data).length, 1, 'reenter company page can record after undo');
});

test('actual inline content/background/panel integration needs manual click and leaves BOSS DOM intact', async () => {
  const env = setup(); env.tab.url = 'https://www.zhipin.com/web/geek/job';
  const { document, window } = parseHTML(readFileSync(new URL('fixtures/inline-detail.html', import.meta.url), 'utf8'));
  const incoming = event(); const intervals = [];
  const context = vm.createContext({
    document, URL, console, location: { get href() { return env.tab.url; } },
    chrome: { runtime: { id: 'test-extension', onMessage: incoming, async sendMessage(msg) {
      const sender = { id: 'test-extension', frameId: 0, tab: { ...env.tab }, url: env.tab.url };
      if (msg.type === 'PAGE_CHANGED') env.chrome.runtime.onMessage.emit(msg, sender, () => {});
      return env.send(msg, sender);
    } } },
    crypto: { randomUUID: () => 'actual-inline-fixture' }, MutationObserver: window.MutationObserver,
    addEventListener: window.addEventListener.bind(window),
    setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
    setTimeout(fn) { Promise.resolve().then(fn); return 1; }, clearTimeout() {}
  });
  env.chrome.tabs.sendMessage = async (id, msg) => {
    assert.equal(id, env.tab.id);
    return new Promise(resolve => incoming.handlers[0](msg, { id: 'test-extension' }, resolve));
  };
  const original = document.toString();
  for (const file of ['core/identity.js', 'core/parser.js', 'core/page-state.js', 'content.js']) vm.runInContext(source(file), context);
  const ui = await panel(env);
  assert.deepEqual(env.storage.data, {});
  ui.click('.mark'); await flush();
  assert.equal(Object.keys(env.storage.data).length, 1);
  assert.equal(ui.document.getElementById('page-badge').textContent, '已记录本次查看');
  intervals[0](); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '已记录本次查看');
  ui.click('.undo'); await flush(); intervals[0](); await flush();
  assert.deepEqual(env.storage.data, {});
  assert.match(ui.document.getElementById('page-content').textContent, /本次已撤销/);
  ui.click('.mark'); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '已记录本次查看');
  document.querySelector('.job-detail').setAttribute('data-job-id', 'job-b'); intervals[0](); await flush();
  document.querySelector('.job-detail').setAttribute('data-job-id', 'job-a'); intervals[0](); await flush();
  assert.equal(ui.document.getElementById('page-badge').textContent, '本次已记录');
  assert.doesNotMatch(ui.document.getElementById('page-content').textContent, /这家公司你之前看过/);
  assert.equal(document.toString(), original, 'extension writes only its panel/storage, never business DOM');
});

test('actual content click records a confirmed search-list card only when the setting is enabled', async () => {
  const env = setup(); env.tab.url = 'https://www.zhipin.com/web/geek/job';
  const { document, window } = parseHTML(readFileSync(new URL('fixtures/inline-detail.html', import.meta.url), 'utf8'));
  const incoming = event(); const intervals = [];
  const context = vm.createContext({
    document, URL, console, location: { get href() { return env.tab.url; } },
    chrome: { runtime: { id: 'test-extension', onMessage: incoming, async sendMessage(msg) {
      const sender = { id: 'test-extension', frameId: 0, tab: { ...env.tab }, url: env.tab.url };
      return env.send(msg, sender);
    } } },
    crypto: { randomUUID: () => 'actual-list-click-fixture' }, MutationObserver: window.MutationObserver,
    addEventListener: window.addEventListener.bind(window),
    setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
    setTimeout(fn) { Promise.resolve().then(fn); return 1; }, clearTimeout() {}
  });
  env.chrome.tabs.sendMessage = async (id, msg) => {
    assert.equal(id, env.tab.id);
    return new Promise(resolve => incoming.handlers[0](msg, { id: 'test-extension' }, resolve));
  };
  for (const file of ['core/identity.js', 'core/parser.js', 'core/page-state.js', 'content.js']) vm.runInContext(source(file), context);
  await flush();
  document.addEventListener('click', event => {
    const link = event.target.closest?.('.job-name');
    if (!link) return;
    document.querySelector('.job-detail').setAttribute('data-job-id', link.getAttribute('href').includes('job-b') ? 'job-b' : 'job-a');
  });
  const jobB = document.querySelectorAll('.job-name')[1];
  jobB.click(); await flush();
  assert.deepEqual(env.storage.data, {});

  env.storage.data[api.LIST_CLICK_VIEW_KEY] = true;
  jobB.click(); await flush(); await flush();
  const record = env.storage.data[api.PREFIX + company(ID_B).key];
  assert.ok(record);
  assert.equal(record.contactedAt, undefined);
  assert.equal(record.contactSource, undefined);
  const page = await env.chrome.tabs.sendMessage(7, { type: 'GET_PAGE' });
  assert.equal(page.history.state, 'manual');
  const firstTime = record.markedAt;
  jobB.click(); await flush(); await flush();
  assert.equal(env.storage.data[api.PREFIX + company(ID_B).key].markedAt, firstTime);
  assert.equal(Object.keys(env.storage.data).filter(key => key.startsWith(api.PREFIX)).length, 1);
});
