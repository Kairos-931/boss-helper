import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.js';
import '../extension/core/job-parser.js';
import '../extension/core/jobs.js';
import '../extension/core/job-api.js';

const HREF = 'https://www.zhipin.com/web/geek/job';
const ENDPOINT = 'https://www.zhipin.com/wapi/zpgeek/job/detail.json';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const payload = (key = 'collection-a', salary = '16-18K·13薪') => ({ code: 0, zpData: { jobInfo: { encryptId: key, salaryDesc: salary }, bossInfo: { syntheticUnused: 'never-persist-full-response' } } });
const response = body => ({ ok: true, url: ENDPOINT, headers: { get: () => 'application/json;charset=UTF-8' }, async text() { return JSON.stringify(body); } });
function event() { return { handlers: [], addListener(fn, filter) { this.handlers.push({ fn, filter }); }, emit(details) { for (const { fn } of this.handlers) fn(details); } }; }
function harness() {
  let now = 10001, running = true, sessionId = 'session-a', focused = true, documentId = 'doc-a';
  const tab = { id: 7, windowId: 3, active: true, status: 'complete', url: HREF }, calls = [], changes = [];
  let transport = async () => response(payload());
  const chrome = {
    webRequest: { onBeforeRequest: event(), onCompleted: event(), onErrorOccurred: event() },
    tabs: { async get(id) { if (id !== 7) throw new Error('Unknown tab'); return { ...tab }; }, async sendMessage(id, message, options) { assert.equal(options.documentId, 'doc-a'); return { documentId, href: tab.url }; } },
    windows: { async get() { return { focused }; } }
  };
  const service = api.createJobApi(chrome, {
    async session(id) { return id === 7 ? { id: sessionId, running, startedAt: 10000 } : null; },
    async changed(id, session) { changes.push([id, session]); }
  }, async (url, options) => { calls.push({ url, options }); return transport(url, options); }, () => now);
  const details = overrides => ({ requestId: 'request-a', tabId: 7, frameId: 0, documentId: 'doc-a', method: 'GET', type: 'xmlhttprequest', initiator: 'https://www.zhipin.com', url: ENDPOINT + '?securityId=synthetic-test-token&lid=synthetic-lid', statusCode: 200, ...overrides });
  return { service, chrome, tab, calls, changes, details, before: async d => { service.before(d || details()); await flush(); }, complete: d => service.completed(d || details()),
    read: key => service.read(7, sessionId, 'doc-a', HREF, key || 'job:collection-a'),
    transport(fn) { transport = fn; }, running(value) { running = value; }, sessionId(value) { sessionId = value; }, focus(value) { focused = value; }, documentId(value) { documentId = value; }, advance(ms) { now += ms; } };
}

test('salary validation retains explicit amounts, decimals, units, salary months and 面议; rejects encoded and unknown values', () => {
  for (const text of ['16-18K·13薪', '1.5-2.5万/月', '200-300元/天', '50-100元/小时', '10-20万元/年', '5000元/月', '月薪 5-8千', '面议', '薪资面议']) assert.equal(api.readableSalary(text), text);
  for (const value of ['', null, 16000, {}, '\ue032\ue036-\ue032\ue038K', '16-18K\ufffd', '保密', '登录查看', '16000', '&#xe032;K', '<b>16-18K</b>', '\udb80\udc00K', '16-18K plus bonus']) assert.equal(api.readableSalary(value), null);
});

test('salary API accepts only verified code/zpData/jobInfo/encryptId/salaryDesc schema and emits the minimal business fields', () => {
  assert.deepEqual(api.parseJobSalaryResponse(payload()), { key: 'job:collection-a', salary: '16-18K·13薪' });
  for (const body of [{ ...payload(), code: 1 }, { ...payload(), code: '0' }, { code: 0, zpData: { salaryDesc: '16-18K' } }, { code: 0, zpData: { jobInfo: { encryptId: '../a', salaryDesc: '16-18K' } } }, payload('a', '\ue032K'), payload('a', 16000), null]) assert.equal(api.parseJobSalaryResponse(body), null);
  assert.equal(api.parseJobSalaryResponse(payload('a', '面议')).salary, '面议');
});

test('only the exact BOSS endpoint is allowed, with no credentials, fragments, foreign paths or hosts', () => {
  assert.equal(api.isJobEndpoint(ENDPOINT + '?securityId=synthetic'), true);
  for (const url of [ENDPOINT + '/other', ENDPOINT + '.other', ENDPOINT + '#fragment', ENDPOINT.replace('https:', 'http:'), ENDPOINT.replace('www.zhipin.com', 'www.zhipin.com.foreign.example'), ENDPOINT.replace('https://', 'https://user:pass@'), 'bad']) assert.equal(api.isJobEndpoint(url), false);
});

test('a genuine foreground page request is reread once, authenticated without redirects, and bound to session/document/job', async () => {
  const h = harness();
  assert.deepEqual(h.chrome.webRequest.onBeforeRequest.handlers[0].filter, { urls: [ENDPOINT + '*'], types: ['xmlhttprequest'] });
  await h.before(); assert.match(h.read().waiting, /读取/); await h.complete();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.changes, [[7, 'session-a']]);
  assert.equal(h.calls[0].options.credentials, 'include'); assert.equal(h.calls[0].options.redirect, 'error');
  assert.deepEqual(h.read(), { salary: '16-18K·13薪' });
  assert.match(h.read('job:other').waiting, /尚未对应/);
  assert.equal(h.service.read(7, 'other', 'doc-a', HREF, 'job:collection-a'), null);
  assert.equal(h.service.read(7, 'session-a', 'other', HREF, 'job:collection-a'), null);
  assert.equal(h.service.read(8, 'session-a', 'doc-a', HREF, 'job:collection-a'), null);
  assert.doesNotMatch(JSON.stringify(h.read()), /synthetic|bossInfo|zpData|securityId/);
  await h.complete(); await h.before(); await h.complete(); assert.equal(h.calls.length, 1);
});

test('foreign frames, other tabs, extension requests, unsupported methods and arbitrary URLs never initiate reads', async () => {
  for (const override of [{ tabId: -1 }, { tabId: 8 }, { frameId: 1 }, { documentId: undefined }, { documentId: 'other' }, { initiator: 'chrome-extension://own-extension' }, { method: 'POST' }, { type: 'main_frame' }, { url: ENDPOINT + '.foreign' }]) {
    const h = harness(), details = h.details(override); await h.before(details); await h.complete(details); assert.equal(h.calls.length, 0); assert.equal(h.changes.length, 0);
  }
});

test('disabled, unfocused, background, loading, pre-start and expired request contexts do not fetch, including start-after-observation', async () => {
  for (const change of [h => h.running(false), h => h.focus(false), h => { h.tab.active = false; }, h => { h.tab.status = 'loading'; }, h => { h.tab.url = 'https://foreign.example/'; }, h => h.advance(-10)]) {
    const h = harness(); change(h); await h.before(); await h.complete(); assert.equal(h.calls.length, 0);
  }
  const h = harness(); h.running(false); await h.before(); h.running(true); h.sessionId('session-b'); await h.complete(); assert.equal(h.calls.length, 0);
  const expired = harness(); await expired.before(); expired.advance(30001); await expired.complete(); assert.equal(expired.calls.length, 0);
  const delayed = harness(), older = delayed.details({ timeStamp: 9999 }); await delayed.before(older); await delayed.complete(older); assert.equal(delayed.calls.length, 0);
});

test('source changes before completion prevent any reread or late result from binding to the new context', async () => {
  for (const change of [h => h.running(false), h => h.focus(false), h => h.sessionId('session-b'), h => h.documentId('doc-b'), h => { h.tab.url = 'https://www.zhipin.com/job_detail/b.html'; }]) {
    const h = harness(); await h.before(); change(h); await h.complete(); assert.equal(h.calls.length, 0); assert.equal(h.changes.length, 0);
  }
});

test('a real navigation request may precede reader installation; it waits and is fetched once when that exact document is ready', async () => {
  for (const phase of ['loading', 'reader']) {
    const h = harness();
    if (phase === 'loading') h.tab.status = 'loading'; else h.documentId('not-yet-ready');
    await h.before(); await h.complete(); assert.equal(h.calls.length, 0);
    h.tab.status = 'complete'; h.documentId('doc-a');
    assert.match(h.read().waiting, /读取/); await flush();
    assert.equal(h.calls.length, 1); assert.deepEqual(h.read(), { salary: '16-18K·13薪' });
    h.read(); await flush(); assert.equal(h.calls.length, 1);
  }
});

test('HTTP failures, verification HTML, business errors, invalid schema/encoding and transport errors stay explicit and redact raw errors', async () => {
  for (const transport of [
    async () => ({ ...response(payload()), ok: false }),
    async () => ({ ...response(payload()), url: 'https://foreign.example/' }),
    async () => ({ ...response(payload()), headers: { get: () => 'text/html' } }),
    async () => response({ code: 37, message: 'synthetic-test-token' }),
    async () => response(payload('a', '\ue032K')),
    async () => ({ ...response(payload()), text: async () => '<html>verification</html>' }),
    async () => { throw new Error(ENDPOINT + '?securityId=synthetic-test-token'); }
  ]) {
    const h = harness(); h.transport(transport); await h.before(); await h.complete(); assert.match(h.read().error, /重新打开/); assert.doesNotMatch(h.read().error, /synthetic|securityId|https:/);
  }
  const h = harness(); await h.before(); await h.complete(h.details({ statusCode: 403 })); assert.equal(h.calls.length, 0); assert.ok(h.read().error);
});

test('an extension reread cannot trigger itself through webRequest events', async () => {
  const h = harness(); h.transport(async () => {
    const own = h.details({ requestId: 'extension-request', tabId: -1, initiator: 'chrome-extension://own-extension' });
    h.chrome.webRequest.onBeforeRequest.emit(own); h.chrome.webRequest.onCompleted.emit(own);
    return response(payload());
  });
  await h.before(); await h.complete(); await flush(); assert.equal(h.calls.length, 1); assert.deepEqual(h.read(), { salary: '16-18K·13薪' });
});

test('newer source requests cancel old reads and late out-of-order responses cannot replace the new job salary', async () => {
  const h = harness(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.transport(async () => h.calls.length === 1 ? gate : response(payload('collection-b', '30-40K·14薪')));
  await h.before(); const old = h.complete(); await flush(); assert.equal(h.calls.length, 1);
  const next = h.details({ requestId: 'request-b', url: ENDPOINT + '?securityId=synthetic-next' });
  await h.before(next); assert.equal(h.calls[0].options.signal.aborted, true); await h.complete(next);
  release(response(payload('collection-a', '16-18K'))); await old;
  assert.equal(h.changes.length, 1); assert.deepEqual(h.read('job:collection-b'), { salary: '30-40K·14薪' }); assert.ok(h.read().waiting);
});

test('pausing/cancelling during a read aborts promptly and ignores a transport that returns late', async () => {
  const h = harness(); let release; h.transport(() => new Promise(resolve => { release = resolve; }));
  await h.before(); const pending = h.complete(); await flush(); h.running(false); h.service.cancel(7);
  assert.equal(h.calls[0].options.signal.aborted, true); release(response(payload())); await pending;
  assert.equal(h.changes.length, 0); assert.equal(h.read(), null);
});

test('document/focus changes during an in-flight reread, expired results and worker restarts never leak stale salaries', async () => {
  for (const change of [h => h.documentId('doc-b'), h => h.focus(false)]) {
    const h = harness(); let release; h.transport(() => new Promise(resolve => { release = resolve; }));
    await h.before(); const pending = h.complete(); await flush(); change(h); release(response(payload())); await pending; assert.equal(h.changes.length, 0); assert.equal(h.read(), null);
  }
  const h = harness(); await h.before(); await h.complete(); h.advance(60001); assert.equal(h.read(), null);
  const restarted = harness(); await restarted.complete(); assert.equal(restarted.calls.length, 0);
});
