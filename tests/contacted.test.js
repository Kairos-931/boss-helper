import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { api, company, ID_A, ID_B, memoryStorage } from './helpers.js';
const source = path => readFileSync(new URL(`../extension/${path}`, import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function event() {
  const handlers = [];
  return { handlers, addListener(fn) { handlers.push(fn); }, removeListener(fn) { const index = handlers.indexOf(fn); if (index >= 0) handlers.splice(index, 1); }, emit(...args) { for (const fn of [...handlers]) fn(...args); } };
}

test('markContacted creates or updates without losing first contact; manual and auto sources stay distinct', async () => {
  const storage = memoryStorage();
  const repository = api.createRepository(storage);
  const auto = await repository.markContacted(company(), 'auto');
  assert.equal(auto.contactedAt, auto.markedAt);
  assert.equal(auto.contactSource, 'auto');
  const manual = await repository.markContacted(company(), 'manual');
  assert.equal(manual.contactedAt, auto.contactedAt);
  assert.equal(manual.contactSource, 'auto');
  const created = await repository.markContacted(company(ID_B, '另一家'), 'manual');
  assert.equal(created.contactSource, 'manual');
  assert.equal(created.contactedAt, created.markedAt);
  for (const bad of [['example', 'auto'], [company(), 'send']]) {
    await assert.rejects(repository.markContacted(bad[0], bad[1]), /无效|无法识别/);
  }
  assert.equal(Object.keys(storage.data).length, 2);
});

test('cancelling manual and automatic contact preserves every other stored field and never recreates a company', async () => {
  const storage = memoryStorage();
  const repository = api.createRepository(storage);
  const originals = ['manual', 'auto'].map((contactSource, index) => ({
    ...company(index ? ID_B : ID_A, index ? '另一家公司' : '原公司名称'),
    markedAt: '2026-10-01T00:00:00Z', contactedAt: '2026-11-01T01:00:00Z', contactSource,
    rest: 'shift-rest', restUpdatedAt: '2026-10-02T00:00:00Z', retainedField: '保留原字段'
  }));
  storage.data['other-local-data'] = { text: '独立数据', height: 240 };
  for (const original of originals) storage.data[api.PREFIX + original.key] = original;
  for (const original of originals) {
    const expected = { ...original };
    delete expected.contactedAt;
    delete expected.contactSource;
    const cancelled = await repository.cancelContacted(original.key);
    assert.equal(cancelled.contactedAt, undefined);
    assert.deepEqual(storage.data[api.PREFIX + original.key], expected);
    await repository.cancelContacted(original.key);
    assert.deepEqual(storage.data[api.PREFIX + original.key], expected);
  }
  assert.equal(await repository.cancelContacted('boss:missing-company-id'), null);
  assert.equal(Object.keys(storage.data).length, 3);
  assert.deepEqual(storage.data['other-local-data'], { text: '独立数据', height: 240 });
  const csv = api.exportCsv(await repository.list());
  assert.match(csv, /2026-10-01T00:00:00Z/);
  assert.match(csv, /"","","排班轮休"/);
  assert.doesNotMatch(csv, /2026-11-01T01:00:00Z|"manual"|"auto"/);
});

test('failed or malformed cancellation preserves the original; retries and later explicit marks recover', async () => {
  const storage = memoryStorage();
  const repository = api.createRepository(storage, () => new Date('2026-11-02T10:00:00Z'));
  const original = { ...company(), markedAt: '2026-10-01T00:00:00Z', contactedAt: '2026-11-01T00:00:00Z', contactSource: 'manual', rest: 'single' };
  storage.data[api.PREFIX + original.key] = original;
  storage.fail('set');
  await assert.rejects(repository.cancelContacted(original.key), /保存失败/);
  assert.deepEqual(storage.data[api.PREFIX + original.key], original);
  storage.fail(null);
  await assert.rejects(repository.cancelContacted('other:key'), /公司记录无效/);
  storage.data[api.PREFIX + company(ID_B).key] = { ...original, markedAt: 'broken' };
  const before = structuredClone(storage.data);
  await assert.rejects(repository.cancelContacted(company(ID_B).key), /原记录格式异常/);
  assert.deepEqual(storage.data, before);
  await repository.cancelContacted(original.key);
  const remarked = await repository.markContacted(company(), 'manual');
  assert.equal(remarked.markedAt, original.markedAt);
  assert.equal(remarked.contactedAt, '2026-11-02T10:00:00.000Z');
  assert.equal(remarked.rest, 'single');
});

test('setRest only updates existing records, keeps history on conflicts and invalid values', async () => {
  const storage = memoryStorage();
  const repository = api.createRepository(storage);
  assert.equal(await repository.setRest(company().key, 'double'), null);
  assert.deepEqual(storage.data, {});
  await repository.mark({ ...company(), nameProof: { kind: 'company-heading', name: company().name } });
  const updated = await repository.setRest(company().key, 'single-double');
  assert.equal(updated.rest, 'single-double');
  assert.match(updated.restUpdatedAt, /^20\d\d/);
  const changed = await repository.setRest(company().key, 'single');
  assert.equal(changed.rest, 'single');
  await assert.rejects(repository.setRest(company().key, '每周双休'), /休息制度无效/);
  await assert.rejects(repository.setRest('other:key', 'single'), /公司记录无效/);
  const listed = await repository.list();
  assert.equal(listed[0].rest, 'single');
});

test('validRecord drops malformed contact/rest fields and CSV adds contacted and rest columns', () => {
  const record = api.validRecord({ ...company(), markedAt: '2026-10-01T00:00:00Z', contactedAt: 'nope', contactSource: 'auto', rest: 'unknown' });
  assert.equal(record.contactedAt, undefined);
  assert.equal(record.rest, undefined);
  const good = api.validRecord({ ...company(), markedAt: '2026-10-01T00:00:00Z', contactedAt: '2026-10-02T00:00:00Z', contactSource: 'manual', rest: 'single' });
  assert.equal(good.contactedAt, '2026-10-02T00:00:00Z');
  assert.equal(api.validRecord({ ...company(), markedAt: '2026-10-01T00:00:00Z', rest: 'shift-rest' }).rest, 'shift-rest');
  assert.equal(api.validRecord({ ...company(), markedAt: '2026-10-01T00:00:00Z', rest: 'monthly:4' }).rest, 'monthly:4');
  assert.equal(api.validRecord({ ...company(), markedAt: '2026-10-01T00:00:00Z', rest: 'monthly:40' }).rest, undefined);
  assert.equal(api.restLabel('shift-rest'), '排班轮休');
  assert.equal(api.restLabel('monthly:4'), '月休4天');
  const csv = api.exportCsv([good]);
  assert.match(csv, /"首次沟通时间（UTC）","沟通来源","休息制度"/);
  assert.match(csv, /2026-10-02T00:00:00Z","manual","单休"/);
});

test('company pages expose a conservative rest classification with conflicts and recommendations excluded', () => {
  const page = (body, title = '公司详情', href = company().url) => {
    const { document } = parseHTML(`<html><head><title>${title}</title></head><body>${body}</body></html>`);
    return api.parsePage(document, href, null);
  };
  assert.equal(page('<div class="company-info"><h1>甲公司</h1><p>休息制度：双休</p></div>').rest, 'double');
  assert.equal(page('<div class="company-info"><h1>甲公司</h1><p>单双休</p></div>').rest, 'single-double');
  assert.equal(page('<div class="company-info"><h1>甲公司</h1><p>单休</p><p>双休</p></div>').rest, null);
  assert.equal(page('<div class="company-info"><h1>甲公司</h1></div><div class="recommendations"><p>双休</p></div>').rest, null);
  assert.equal(page('<div class="company-info"><h1>甲公司</h1><p style="display:none">单休</p></div>').rest, null);
  assert.equal(page('<div class="company-info"><h1>甲公司</h1><button>双休</button></div>').rest, null);
  assert.equal(page('<div class="company-info"><h1>甲公司</h1></div><div class="job-sec work-time"><h3>工作时间及福利</h3><p><span>排班轮休、偶尔加班</span></p></div>').rest, 'shift-rest');
  assert.equal(page('<div class="company-info"><h1>甲公司</h1></div><div class="job-sec work-time"><p><span>大小周</span></p></div>').rest, 'big-small-week');
  assert.equal(page('<div class="company-info"><h1>甲公司</h1></div><div class="job-sec work-time"><p><span>月休4天</span></p></div>').rest, 'monthly:4');
  assert.equal(page('<div class="company-info"><h1>甲公司</h1></div><div class="job-sec work-time"><p><span>排班轮休</span></p><p><span>双休</span></p></div>').rest, null);
  assert.equal(page('<div class="company-info"><h1>甲公司</h1></div><p>排班轮休</p>').rest, null);
  assert.equal(page('<div class="job-detail"><p>双休</p></div>', '职位详情', 'https://www.zhipin.com/job_detail/one.html').rest ?? null, null);
  const snapshot = api.validateSnapshot({ ...page('<div class="company-info"><h1>甲公司</h1><p>单双休</p></div>'), href: company().url, token: 'doc:1', visitId: 'v1' }, company().url);
  assert.equal(snapshot.rest, 'single-double');
  assert.equal(api.validateSnapshot({ ...page('<div class="company-info"><h1>甲公司</h1></div>'), href: company().url, token: 'doc:1', visitId: 'v1', rest: 'bogus' }, company().url).rest, null);
});

function background() {
  const storage = memoryStorage();
  const session = memoryStorage();
  const local = { ...storage, async setAccessLevel() {} };
  const onRemoved = event();
  const chrome = {
    runtime: { id: 'test-extension', onMessage: event(), onInstalled: event(), onStartup: event(), getManifest: () => ({ version: '0.6.0' }) },
    storage: { local, session, onChanged: event() },
    sidePanel: { async setPanelBehavior() {}, async setOptions() {} },
    windows: { async get() { return { id: 3, focused: true }; }, async getCurrent() { return { id: 3 }; } },
    tabs: { onUpdated: event(), onActivated: event(), onRemoved, onCreated: event(), async query() { return []; }, async get(id) { return { id, active: true, windowId: 3, status: 'complete' }; } }
  };
  const context = vm.createContext({ chrome, URL, Date, Intl, console });
  context.importScripts = (...paths) => { for (const path of paths) vm.runInContext(source(path), context); };
  vm.runInContext(source('background.js'), context);
  const listener = chrome.runtime.onMessage.handlers[0];
  const send = (msg, sender) => new Promise(resolve => { if (!listener(msg, sender, resolve)) resolve(undefined); });
  return { storage, session, chrome, send, onRemoved };
}
const tabSender = url => ({ id: 'test-extension', frameId: 0, tab: { id: 7 }, url });
const chatSender = () => tabSender('https://www.zhipin.com/web/geek/chat?securityId=x');
const panelSender = () => ({ id: 'test-extension', url: 'chrome-extension://test-extension/panel.html' });

test('panel-only cancellation clears every same-company context, keeps other companies and permits a fresh source', async () => {
  const env = background();
  await env.send({ type: 'MARK_CONTACTED', ...company() }, panelSender());
  const firstViewed = env.storage.data[api.PREFIX + company().key].markedAt;
  await env.send({ type: 'INITIATE_CHAT', ...company() }, tabSender(company().url));
  env.chrome.tabs.onCreated.emit({ id: 9, openerTabId: 7 });
  await flush();
  const otherSender = { ...tabSender(company(ID_B).url), tab: { id: 11 } };
  await env.send({ type: 'INITIATE_CHAT', ...company(ID_B) }, otherSender);
  const before = structuredClone(env.storage.data);
  for (const sender of [tabSender(company().url), { ...panelSender(), id: 'foreign' }, { ...panelSender(), url: 'chrome-extension://test-extension/other.html' }]) {
    assert.equal(await env.send({ type: 'CANCEL_CONTACTED', key: company().key }, sender), undefined);
  }
  assert.deepEqual(env.storage.data, before);
  assert.equal((await env.send({ type: 'CANCEL_CONTACTED', key: company().key }, panelSender())).ok, true);
  assert.equal(env.storage.data[api.PREFIX + company().key].contactedAt, undefined);
  assert.equal(env.storage.data[api.PREFIX + company().key].markedAt, firstViewed);
  assert.equal(env.session.data['chat-ctx:7'], undefined);
  assert.equal(env.session.data['chat-ctx:9'], undefined);
  assert.equal(env.session.data['chat-ctx:11'].key, company(ID_B).key);
  for (const tabId of [7, 9]) assert.equal((await env.send({ type: 'CHAT_SENT' }, { ...chatSender(), tab: { id: tabId } })).recorded, false);
  assert.equal(Object.keys(env.storage.data).length, 1);
  await env.send({ type: 'INITIATE_CHAT', ...company() }, tabSender(company().url));
  assert.equal((await env.send({ type: 'CHAT_SENT' }, chatSender())).recorded, true);
  assert.equal(env.storage.data[api.PREFIX + company().key].contactSource, 'auto');
  assert.equal(env.storage.data[api.PREFIX + company().key].markedAt, firstViewed);
});

test('cancellation and delayed chat consumption or opener inheritance serialize in either arrival order', async () => {
  for (const order of ['sent-first', 'cancel-first']) {
    const env = background();
    await env.send({ type: 'MARK_CONTACTED', ...company() }, panelSender());
    await env.send({ type: 'INITIATE_CHAT', ...company() }, tabSender(company().url));
    env.chrome.tabs.onCreated.emit({ id: 9, openerTabId: 7 });
    await flush();
    let release;
    let began;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { began = resolve; });
    const read = env.chrome.storage.session.get;
    let delayed = false;
    env.chrome.storage.session.get = async key => {
      const value = await read(key);
      if (!delayed && key === (order === 'sent-first' ? 'chat-ctx:7' : null)) {
        delayed = true; began(); await gate;
      }
      return value;
    };
    const sendOld = () => env.send({ type: 'CHAT_SENT' }, chatSender());
    const cancel = () => env.send({ type: 'CANCEL_CONTACTED', key: company().key }, panelSender());
    const first = order === 'sent-first' ? sendOld() : cancel();
    await started;
    const second = order === 'sent-first' ? cancel() : sendOld();
    env.chrome.tabs.onCreated.emit({ id: 10, openerTabId: 9 });
    release();
    const replies = await Promise.all([first, second]);
    await flush();
    assert.equal(replies.every(reply => reply.ok), true, order);
    if (order === 'cancel-first') assert.equal(replies[1].recorded, false);
    assert.equal(env.storage.data[api.PREFIX + company().key].contactedAt, undefined, order);
    assert.deepEqual(env.session.data, {}, order);
    assert.equal((await env.send({ type: 'CHAT_SENT' }, { ...chatSender(), tab: { id: 10 } })).recorded, false, order);
  }
});

test('context cleanup and contact save failures never report a successful cancellation and do not poison the queue', async () => {
  for (const failure of ['session-get', 'session-remove', 'local-set']) {
    const env = background();
    await env.send({ type: 'MARK_CONTACTED', ...company() }, panelSender());
    await env.send({ type: 'INITIATE_CHAT', ...company() }, tabSender(company().url));
    const original = structuredClone(env.storage.data);
    if (failure === 'local-set') env.storage.fail('set');
    else env.session.fail(failure === 'session-get' ? 'get' : 'remove');
    const failed = await env.send({ type: 'CANCEL_CONTACTED', key: company().key }, panelSender());
    assert.equal(failed.ok, false, failure);
    assert.deepEqual(env.storage.data, original, failure);
    env.storage.fail(null); env.session.fail(null);
    const retried = await env.send({ type: 'CANCEL_CONTACTED', key: company().key }, panelSender());
    assert.equal(retried.ok, true, failure);
    assert.equal(env.storage.data[api.PREFIX + company().key].contactedAt, undefined, failure);
    assert.equal((await env.send({ type: 'CHAT_SENT' }, chatSender())).recorded, false, failure);
  }
});

test('chat send with initiated context records the company once; without context it stays silent', async () => {
  const env = background();
  assert.equal((await env.send({ type: 'CHAT_SENT', href: 'https://www.zhipin.com/web/geek/chat' }, chatSender())).recorded, false);
  assert.deepEqual(env.storage.data, {});
  const initiate = await env.send({ type: 'INITIATE_CHAT', ...company() }, tabSender('https://www.zhipin.com/job_detail/one.html'));
  assert.equal(initiate.ok, true);
  assert.equal((await env.send({ type: 'INITIATE_CHAT', ...company() }, tabSender('https://www.zhipin.com/web/geek/job?query=1'))).ok, false);
  const sent = await env.send({ type: 'CHAT_SENT', href: 'https://www.zhipin.com/web/geek/chat' }, chatSender());
  assert.equal(sent.recorded, true);
  const record = Object.values(env.storage.data)[0];
  assert.equal(record.contactSource, 'auto');
  assert.equal(record.contactedAt, record.markedAt);
  assert.equal((await env.send({ type: 'CHAT_SENT', href: 'https://www.zhipin.com/web/geek/chat' }, chatSender())).recorded, false);
  assert.equal(Object.values(env.storage.data)[0].contactedAt, record.contactedAt);
  assert.equal(await env.send({ type: 'INITIATE_CHAT', ...company() }, { id: 'test-extension', frameId: 1, tab: { id: 7 }, url: 'https://www.zhipin.com/job_detail/one.html' }), undefined);
  env.onRemoved.emit(7, {}, { id: 7 });
  await flush();
  assert.equal((await env.send({ type: 'CHAT_SENT', href: 'https://www.zhipin.com/web/geek/chat' }, chatSender())).recorded, false);
});

test('rest seen updates only existing records; manual contact is panel-only and idempotent', async () => {
  const env = background();
  assert.equal((await env.send({ type: 'REST_SEEN', key: company().key, rest: 'single' }, tabSender(company().url))).updated, false);
  assert.deepEqual(env.storage.data, {});
  await env.send({ type: 'MARK_CONTACTED', ...company() }, panelSender());
  assert.equal((await env.send({ type: 'REST_SEEN', key: company().key, rest: 'single-double' }, tabSender(company().url))).updated, true);
  const stored = Object.values(env.storage.data)[0];
  assert.equal(stored.rest, 'single-double');
  assert.equal(stored.contactSource, 'manual');
  const invalidRest = await env.send({ type: 'REST_SEEN', key: company().key, rest: 'bogus' }, tabSender(company().url));
  assert.equal(invalidRest.ok, false);
  assert.match(invalidRest.error, /休息制度无效/);
  const first = Object.values(env.storage.data)[0].contactedAt;
  await env.send({ type: 'MARK_CONTACTED', ...company() }, panelSender());
  assert.equal(Object.values(env.storage.data)[0].contactedAt, first);
  assert.equal(await env.send({ type: 'MARK_CONTACTED', ...company() }, tabSender(company().url)), undefined);
  await assert.rejects(env.send({ type: 'MARK_CONTACTED', key: company().key, name: '', url: company().url }, panelSender()).then(reply => {
    if (!reply.ok) throw new Error(reply.error);
    return reply;
  }), /无法识别公司/);
});

test('panel shows contacted priority, rest warnings and a manual mark button before undo', async () => {
  const env = background();
  env.chrome.runtime.sendMessage = async payload => ({ ok: true, ...(await env.send(payload, panelSender())) });
  env.storage.data[api.PREFIX + company().key] = { ...company(), markedAt: '2026-10-01T00:00:00Z', rest: 'shift-rest', restUpdatedAt: '2026-10-02T01:00:00Z' };
  const page = api.createPageState(() => ({ kind: 'detail', detailType: 'company', subject: company().key, source: 'company-page', current: company(), companies: [], unresolved: 0, rest: 'shift-rest', reason: '' }), () => company().url, 'doc-panel');
  const snapshot = page.refresh();
  env.chrome.tabs.query = async () => [{ id: 7, active: true, windowId: 3, url: company().url, status: 'complete' }];
  env.chrome.tabs.sendMessage = async (id, msg) => {
    assert.equal(msg.type, 'GET_PAGE');
    return { ...snapshot, history: { state: 'prior', visitId: snapshot.visitId, markedAt: '2026-10-01T00:00:00Z' } };
  };
  const { document } = parseHTML(source('panel.html'));
  const context = vm.createContext({
    chrome: env.chrome, document, Blob, URL, Date, Intl, console, innerHeight: 800,
    navigator: { clipboard: { async writeText() {} } }, crypto: { randomUUID: () => 'panel-test' },
    addEventListener() {}, setInterval() { return 1; }, setTimeout() { return 1; }
  });
  for (const file of ['core/identity.js', 'core/rest.js', 'core/page-state.js', 'core/records.js', 'core/visits.js', 'core/pad.js', 'pad.js']) vm.runInContext(source(file), context);
  const code = source('panel.js').replace(/^import .*;\r?\n/gm, '');
  await vm.runInContext(`(async () => { ${code}\n })()`, context);
  await flush();
  assert.equal(document.getElementById('page-badge').textContent, '之前已看过');
  assert.match(document.getElementById('page-content').textContent, /注意：休息制度为排班轮休/);
  const row = document.querySelector('#record-list li .row-top');
  const mark = row.querySelector('.mark-contacted');
  assert.ok(mark);
  assert.ok(row.querySelector('.undo'));
  assert.ok([...row.children].indexOf(mark) < [...row.children].indexOf(row.querySelector('.undo')));
  assert.equal(row.querySelector('.badge.contacted'), null);
  assert.ok(row.querySelector('.rest-tag'));
  assert.equal(row.querySelector('.rest-tag').textContent, '排班轮休');
  assert.equal(document.getElementById('page-badge').textContent, '之前已看过');
  assert.match(document.getElementById('page-content').textContent, /注意：休息制度为排班轮休/);
  mark.disabled = false;
  mark.click();
  await flush();
  assert.match(document.getElementById('feedback').textContent, /已记录 示例公司 的沟通/);
  assert.equal(document.getElementById('page-badge').textContent, '已沟通');
  assert.equal(document.getElementById('page-content').closest('section').classList.contains('history-warning'), true);
  assert.ok(document.querySelector('#record-list li .badge.contacted'));
  assert.equal(document.querySelector('#record-list li .mark-contacted'), null);
  const cancel = document.querySelector('#record-list li .cancel-contacted');
  assert.equal(cancel.textContent, '取消已沟通');
  assert.match(cancel.getAttribute('aria-label'), /保留已查看记录/);
  const firstViewed = Object.values(env.storage.data)[0].markedAt;
  cancel.click();
  await flush();
  assert.equal(document.getElementById('page-badge').textContent, '之前已看过');
  assert.equal(document.getElementById('record-count').textContent, '1');
  assert.ok(document.querySelector('#record-list .mark-contacted'));
  assert.equal(document.querySelector('#record-list .badge.contacted'), null);
  assert.equal(Object.values(env.storage.data)[0].markedAt, firstViewed);
  assert.equal(Object.values(env.storage.data)[0].rest, 'shift-rest');
});

async function contentReader(env, markup) {
  const { document, window } = parseHTML(markup);
  const original = document.toString();
  const signals = [];
  const intervals = [];
  let now = Date.now();
  class ReaderDate extends Date { static now() { return now; } }
  const runtime = {
    id: 'test-extension', onMessage: event(),
    async sendMessage(message) { signals.push(message); return env.send(message, tabSender('https://www.zhipin.com/job_detail/one.html')); }
  };
  const context = vm.createContext({
    document, URL, Date: ReaderDate, console, chrome: { runtime }, location: { href: 'https://www.zhipin.com/job_detail/one.html' },
    crypto: { randomUUID: () => 'contact-content-fixture' }, MutationObserver: window.MutationObserver,
    setInterval(handler) { intervals.push(handler); return intervals.length; }, clearInterval() {},
    setTimeout(handler) { Promise.resolve().then(handler); return 1; }, clearTimeout() {}
  });
  for (const file of ['core/identity.js', 'core/rest.js', 'core/parser.js', 'core/page-state.js', 'content.js']) vm.runInContext(source(file), context);
  await flush();
  assert.equal(document.toString(), original);
  return { document, signals, context, advance(milliseconds) { now += milliseconds; }, poll() { for (const handler of intervals) handler(); } };
}

test('actual reader deduplicates old message IDs across rerenders and recovery; a fresh message with unchanged count can mark again', async () => {
  const env = background();
  const bubble = id => `<li class="message-item item-myself" data-mid="${id}"><span>synthetic-private-body</span></li>`;
  const reader = await contentReader(env, `<html><head><title>合成职位页</title></head><body><div class="job-detail"><h1>产品经理</h1></div><div class="job-company"><a class="company-name" href="${company().url}">示例公司</a></div><button id="initiate">立即沟通</button><ul id="messages">${bubble('synthetic-old-id')}</ul></body></html>`);
  await env.send({ type: 'MARK_CONTACTED', ...company() }, panelSender());
  const firstViewed = env.storage.data[api.PREFIX + company().key].markedAt;
  reader.document.getElementById('initiate').click();
  await flush();
  assert.ok(env.session.data['chat-ctx:7']);
  await env.send({ type: 'CANCEL_CONTACTED', key: company().key }, panelSender());
  const sentCount = () => reader.signals.filter(signal => signal.type === 'CHAT_SENT').length;
  const originalCount = sentCount();
  reader.document.getElementById('messages').innerHTML = bubble('synthetic-old-id');
  reader.poll(); await flush();
  assert.equal(sentCount(), originalCount);
  reader.document.getElementById('messages').innerHTML = bubble('synthetic-after-cancel-id');
  reader.poll(); await flush();
  assert.equal(env.storage.data[api.PREFIX + company().key].contactedAt, undefined);
  reader.advance(3000);
  reader.document.getElementById('initiate').click();
  await flush();
  reader.document.getElementById('messages').innerHTML = bubble('synthetic-old-id');
  reader.poll(); await flush();
  assert.equal(env.storage.data[api.PREFIX + company().key].contactedAt, undefined);
  reader.document.getElementById('messages').innerHTML = bubble('synthetic-fresh-id');
  reader.poll(); await flush();
  assert.equal(env.storage.data[api.PREFIX + company().key].contactSource, 'auto');
  assert.equal(env.storage.data[api.PREFIX + company().key].markedAt, firstViewed);
  await env.send({ type: 'CANCEL_CONTACTED', key: company().key }, panelSender());
  const beforeRecovery = sentCount();
  const beforeDom = reader.document.toString();
  reader.context.BossTracker.reader.dispose();
  vm.runInContext(source('content.js'), reader.context);
  reader.poll(); await flush();
  assert.equal(sentCount(), beforeRecovery);
  assert.equal(env.storage.data[api.PREFIX + company().key].contactedAt, undefined);
  assert.equal(reader.document.toString(), beforeDom);
  assert.doesNotMatch(JSON.stringify([env.storage.data, env.session.data, reader.signals]), /synthetic-private-body|synthetic-old-id|synthetic-fresh-id/);
  reader.context.BossTracker.reader.dispose();
});
test('direct job detail with a sider company establishes chat context and marks only after an actual sent message', async () => {
  const env = background();
  const reader = await contentReader(env, `
    <html><head><title>合成直链职位页</title></head><body>
      <div class="sider-company">
        <div class="company-info">
          <a href="${company().url}" title="旭创科技"><img src="synthetic-logo.png" alt=""></a>
          <a href="${company().url}" title="旭创科技">旭创科技</a>
        </div>
        <a class="look-all" href="/gongsi/job/${ID_A}.html">查看全部职位</a>
      </div>
      <div class="job-detail">
        <h1>产品经理</h1>
        <a href="/job_detail/one.html">当前职位</a>
        <div class="more-job-section">
          <ul class="look-job-list">
            <li><a href="/job_detail/recommended.html">推荐岗位</a></li>
          </ul>
        </div>
        <button id="initiate">立即沟通</button>
        <ul id="messages"></ul>
      </div>
    </body></html>
  `);
  reader.document.getElementById('initiate').click();
  await flush();
  assert.ok(env.session.data['chat-ctx:7']);
  assert.equal(env.storage.data[api.PREFIX + company().key], undefined);
  reader.document.getElementById('messages').innerHTML = '<li class="message-item item-myself" data-mid="synthetic-new-message"><span>synthetic-private-body</span></li>';
  reader.poll();
  await flush();
  assert.equal(env.storage.data[api.PREFIX + company().key].contactSource, 'auto');
  assert.ok(env.storage.data[api.PREFIX + company().key].contactedAt);
  assert.doesNotMatch(JSON.stringify(env.storage.data), /synthetic-private-body/);
  reader.context.BossTracker.reader.dispose();
});
test('start-chat modal sent status marks only the initiated current company without reading message text', async () => {
  const env = background();
  const reader = await contentReader(env, `
    <html><head><title>合成沟通弹窗页</title></head><body>
      <div class="sider-company"><div class="company-info"><a href="${company().url}" title="示例公司">示例公司</a></div></div>
      <div class="job-detail"><h1>产品经理</h1><a href="/job_detail/one.html">当前职位</a><button id="initiate">立即沟通</button></div>
      <div class="dialog-wrap startchat-dialog">
        <div class="dialog-container"><div class="startchat-content"><div class="left"><div class="message"><ul class="message-list"></ul></div><div class="edit-area"><textarea class="input-area"></textarea><div class="send-message disable">发送</div></div></div></div></div>
      </div>
    </body></html>
  `);
  reader.document.getElementById('initiate').click();
  await flush();
  assert.ok(env.session.data['chat-ctx:7']);
  assert.equal(env.storage.data[api.PREFIX + company().key], undefined);
  reader.document.querySelector('.startchat-dialog .message-list').innerHTML = '<li class="message-item" id="synthetic-modal-message"><span class="status success">已发送</span><p class="text">synthetic-private-body</p></li>';
  reader.poll();
  await flush();
  assert.equal(env.storage.data[api.PREFIX + company().key].contactSource, 'auto');
  assert.ok(env.storage.data[api.PREFIX + company().key].contactedAt);
  assert.doesNotMatch(JSON.stringify(env.storage.data), /synthetic-private-body/);
  reader.context.BossTracker.reader.dispose();
});

test('job details without known company regions fall back to one unique brand link; conflicts and recommendations stay unknown', () => {
  const base = 'https://www.zhipin.com/job_detail/one.html';
  const page = (body, href = base) => {
    const { document } = parseHTML(`<html><head><title>职位详情</title></head><body>${body}</body></html>`);
    return api.parsePage(document, href, null);
  };
  const single = page(`<a class="brand" href="https://www.zhipin.com/gongsi/${ID_B}.html"><span class="company-name">苏州佳智彩光电科技招聘</span></a><div class="job-detail"><h1>产品经理</h1></div>`);
  assert.equal(single.current?.key, `boss:${ID_B}`);
  assert.equal(single.current.name, '苏州佳智彩光电科技招聘');
  const conflict = page(`<a href="https://www.zhipin.com/gongsi/${ID_B}.html">甲公司</a><a href="https://www.zhipin.com/gongsi/${ID_A}.html">乙公司</a><div class="job-detail"><h1>职位</h1></div>`);
  assert.equal(conflict.current, null);
  const recommended = page(`<div class="recommendations"><a href="https://www.zhipin.com/gongsi/${ID_B}.html">推荐公司</a></div><div class="job-detail"><h1>职位</h1></div>`);
  assert.equal(recommended.current, null);
  const cardOnly = page(`<li class="job-card-wrapper"><a class="company-name" href="https://www.zhipin.com/gongsi/${ID_B}.html">卡片公司</a></li><div class="job-detail"><h1>职位</h1></div>`);
  assert.equal(cardOnly.current, null);
});

test('company heading excludes favorite nodes by structure while genuine names keep 收藏', () => {
  const page = body => {
    const { document } = parseHTML(`<html><head><title>公司详情</title></head><body>${body}</body></html>`);
    return api.parsePage(document, company().url, null);
  };
  const cleaned = page('<div class="company-banner"><h1>RENOGY如果新能源<span class="company-fav" ka="company-detail-fav">收藏</span></h1></div>');
  assert.equal(cleaned.current?.name, 'RENOGY如果新能源');
  const realLayout = page('<div class="company-info"><h1 class="name">华达新材料<i class="icon-brand"></i><div class="icon-focus">收藏</div></h1></div>');
  assert.equal(realLayout.current?.name, '华达新材料');
  const legal = page('<div class="company-banner"><h1>收藏文化有限公司</h1></div>');
  assert.equal(legal.current?.name, '收藏文化有限公司');
});

test('pending chat context binds to opener tabs, tolerates any boss sender page and expires', async () => {
  const env = background();
  const senderFor = (id, url) => ({ id: 'test-extension', frameId: 0, tab: { id }, url });
  const chatUrl = 'https://www.zhipin.com/web/geek/chat?securityId=x';
  assert.equal((await env.send({ type: 'INITIATE_CHAT', ...company() }, senderFor(7, company().url))).ok, true);
  env.chrome.tabs.onCreated.emit({ id: 9, openerTabId: 7 });
  await flush();
  assert.equal((await env.send({ type: 'CHAT_SENT', href: chatUrl }, senderFor(9, chatUrl))).recorded, true);
  assert.equal((await env.send({ type: 'CHAT_SENT', href: chatUrl }, senderFor(7, chatUrl))).recorded, true);
  assert.equal(Object.keys(env.storage.data).length, 1);
  env.session.data['chat-ctx:7'] = { ...company(ID_B, '过期公司'), at: '2020-01-01T00:00:00Z' };
  assert.equal((await env.send({ type: 'CHAT_SENT', href: chatUrl }, senderFor(7, chatUrl))).recorded, false);
  assert.equal(env.session.data['chat-ctx:7'], undefined);
  env.session.data['chat-ctx:7'] = { ...company(), at: 'not-a-date' };
  assert.equal((await env.send({ type: 'CHAT_SENT', href: chatUrl }, senderFor(7, chatUrl))).recorded, false);
});



