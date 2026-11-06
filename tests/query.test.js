import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { api, company, ID_B, memoryStorage } from './helpers.js';

const source = path => readFileSync(new URL(`../extension/${path}`, import.meta.url), 'utf8');
const flush = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve)); };
function event() {
  const handlers = [];
  return { handlers, addListener(handler) { handlers.push(handler); }, removeListener(handler) { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1); }, emit(...args) { for (const handler of [...handlers]) handler(...args); } };
}
const chatMarkup = (name = '华达新材料', selectedName = name) => `<html><head><title>合成会话</title></head><body>
  <div class="company-banner"><h1>背景公司<div class="icon-focus">收藏</div></h1></div>
  <div class="friend-content selected"><div class="name-box"><span class="name-text">示例联系人</span><span>${selectedName}</span><i class="vline"></i><span>招聘顾问</span></div></div>
  <div class="chat-conversation"><div class="top-info-content">
    <div class="base-info"><div class="name-content"><span class="name-text">示例联系人</span></div><span>${name}</span><i class="vline"></i><span class="base-title">招聘顾问</span></div>
    <div class="chat-position-content"><span class="position-name">产品经理</span></div>
  </div><div class="chat-message"><ul class="im-list"><li class="message-item item-friend"><div>合成内容</div></li></ul></div></div>
  <div class="recommendations"><div class="company-name">推荐公司</div></div>
</body></html>`;

test('name-only job queries use a company node, exclude contact/action text and wait for the selected job', () => {
  const document = parseHTML(`<html><head><title>合成职位</title></head><body><div class="company-banner"><h1>华达新材料<div class="icon-focus">收藏</div></h1></div><div class="job-detail" data-job-id="one"><h1>产品经理</h1></div></body></html>`).document;
  const original = document.toString();
  const href = 'https://www.zhipin.com/job_detail/one.html';
  const page = api.parsePage(document, href);
  assert.equal(page.current, null);
  assert.equal(page.nameHint, '华达新材料');
  assert.equal(page.jobHint, '产品经理');
  assert.equal(document.toString(), original);
  assert.equal(api.parsePage(document, href, 'job:two').nameHint, null);
  document.querySelector('.company-banner').setAttribute('hidden', '');
  assert.equal(api.parsePage(document, href).nameHint, null);
  const contactOnly = parseHTML('<div class="name-content"><span class="name-text">示例联系人</span></div><div class="job-detail"><h1>产品经理</h1></div>').document;
  assert.equal(api.parsePage(contactOnly, href).nameHint, null);
  const recommendations = parseHTML('<div class="recommendations"><div class="company-name">推荐公司</div></div><div class="job-detail"><h1>产品经理</h1></div>').document;
  assert.equal(api.parsePage(recommendations, href).nameHint, null);
});

test('a visible current conversation overrides the company behind it and never exposes a recordable identity', () => {
  const document = parseHTML(chatMarkup()).document;
  const original = document.toString();
  const page = api.parsePage(document, company().url);
  assert.equal(page.kind, 'query');
  assert.equal(page.current, null);
  assert.equal(page.nameHint, '华达新材料');
  assert.equal(page.jobHint, '产品经理');
  assert.equal(document.toString(), original);
  const state = api.createPageState(() => api.parsePage(document, company().url), () => company().url, 'query-document');
  const snapshot = state.refresh();
  assert.equal(state.confirmVisit(snapshot.token, company().key, snapshot.visitId), null);
  assert.equal(state.confirmManual(snapshot.token, company().key, snapshot.visitId), null);
  const guarded = api.validateSnapshot({ ...snapshot, current: company(), companies: [company()], detailType: 'company', rest: 'single', history: { state: 'first', visitId: snapshot.visitId } }, company().url);
  assert.equal(guarded.current, null);
  assert.equal(guarded.detailType, 'job');
  assert.equal(guarded.history, null);
  assert.equal(guarded.rest, null);
  assert.deepEqual(guarded.companies, []);
  document.querySelector('.chat-conversation').style.display = 'none';
  assert.equal(api.parsePage(document, company().url).current.key, company().key);
});

test('conversation switch conflicts and missing company headers hide old candidates and ignore recruiter names', () => {
  const document = parseHTML(chatMarkup()).document;
  const href = 'https://www.zhipin.com/web/geek/chat';
  const state = api.createPageState(() => api.parsePage(document, href), () => href, 'chat-query');
  const first = state.refresh();
  document.querySelector('.friend-content.selected .name-box > span:not([class])').textContent = '新公司';
  const waiting = state.refresh();
  assert.equal(waiting.nameHint, null);
  assert.equal(waiting.jobHint, null);
  assert.notEqual(waiting.token, first.token);
  document.querySelector('.base-info > span:not([class])').textContent = '新公司';
  assert.equal(state.refresh().nameHint, '新公司');
  document.querySelector('.base-info > span:not([class])').remove();
  assert.equal(state.refresh().nameHint, null);
  document.querySelector('.chat-conversation').insertAdjacentHTML('afterend', '<div class="chat-conversation"><div class="company-name">另一个会话</div></div>');
  assert.equal(api.parsePage(document, href).nameHint, null);
});

test('fuzzy matching ranks normalized names, abbreviations and one-character differences without merging or mutating records', () => {
  const makeRecord = (name, index) => ({ ...company(`${ID_B}-${index}`, name), markedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z` });
  const records = [makeRecord('华达新材料有限公司', 0), makeRecord('南通华达新材料有限责任公司', 1), makeRecord('华达新材科', 2), makeRecord('华盛集团', 3), makeRecord('华达新材料', 4), makeRecord('科技有限公司', 5)];
  const original = structuredClone(records);
  const matches = api.fuzzyMatchRecords(records, ' 华达 新材料 招聘 ');
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map(record => record.name), ['华达新材料', '华达新材料有限公司', '南通华达新材料有限责任公司']);
  assert.equal(api.fuzzyMatchRecords(records, '华达新材斜')[0].name, '华达新材料');
  assert.equal(api.fuzzyMatchRecords(records, '无关名称').length, 0);
  for (const hint of ['', null, '华', '科技', '新材料', '公司', 'AB']) assert.deepEqual(api.fuzzyMatchRecords(records, hint), []);
  const latin = [makeRecord('ABC（上海）有限公司', 6)];
  assert.equal(api.fuzzyMatchRecords(latin, 'ａｂｃ')[0].name, latin[0].name);
  assert.deepEqual(records, original);
});

async function queryPanel(raw, storedRecords) {
  const requests = [];
  const storage = memoryStorage();
  for (const record of storedRecords) storage.data[api.PREFIX + record.key] = record;
  const repository = api.createRepository(storage);
  const tab = { id: 7, windowId: 3, url: raw.href, status: 'complete', active: true };
  let snapshot = raw;
  const chrome = {
    runtime: {
      id: 'query-extension', onMessage: event(), getManifest: () => JSON.parse(source('manifest.json')),
      async sendMessage(payload) {
        requests.push(payload);
        if (payload.type === 'RECORDS') return { ok: true, records: await repository.list() };
        if (payload.type === 'PAD_READ') return { ok: true, pad: { text: '', height: 160, revision: 0, writer: '', sequence: 0 } };
        if (payload.type === 'READ_PAGE') return { ok: true, snapshot, recovered: false };
        return { ok: false, error: 'Unexpected write during query' };
      }
    },
    windows: { async getCurrent() { return { id: 3 }; } },
    tabs: { onActivated: event(), onUpdated: event(), onRemoved: event(), async query() { return [{ ...tab }]; }, async sendMessage() { return snapshot; } },
    storage: { onChanged: event() }
  };
  const { document } = parseHTML(source('panel.html'));
  const intervals = [];
  const context = vm.createContext({ chrome, document, Blob, URL, Date, Intl, console, innerHeight: 800, crypto: { randomUUID: () => 'query-panel' }, navigator: { clipboard: { async writeText() {} } }, addEventListener() {}, setInterval(handler) { intervals.push(handler); return intervals.length; }, setTimeout() { return 1; } });
  const panelSource = source('panel.js');
  for (const match of panelSource.matchAll(/^import '\.\/(.+)';/gm)) vm.runInContext(source(match[1]), context);
  await vm.runInContext(`(async () => { ${panelSource.replace(/^import .*;\r?\n/gm, '')}\n })()`, context);
  await flush();
  return { document, storage, requests, intervals, setSnapshot(next) { snapshot = next; } };
}

test('panel shows possible records including saved contact metadata; refresh and matching never write records', async () => {
  const href = 'https://www.zhipin.com/web/geek/chat';
  const parsed = api.parsePage(parseHTML(chatMarkup()).document, href);
  const raw = { ...parsed, href, token: 'query:1', visitId: '' };
  const records = [{ ...company(undefined, '华达新材料有限公司'), markedAt: '2026-10-01T00:00:00Z', contactedAt: '2026-10-02T00:00:00Z', contactSource: 'manual' }];
  const panel = await queryPanel(raw, records);
  const original = structuredClone(panel.storage.data);
  assert.equal(panel.document.getElementById('page-badge').textContent, '可能看过');
  assert.match(panel.document.getElementById('page-content').textContent, /华达新材料.*当前岗位：产品经理/);
  assert.match(panel.document.getElementById('page-content').textContent, /该记录已标记沟通/);
  assert.equal(panel.document.querySelector('#page-content .mark'), null);
  assert.equal(panel.document.querySelector('#page-content .mark-contacted'), null);
  assert.equal(panel.document.querySelector('#page-content .secondary'), null);
  assert.equal(panel.document.getElementById('page-content').closest('section').classList.contains('history-warning'), false);
  panel.document.getElementById('reconnect').click();
  await flush();
  assert.equal(panel.document.getElementById('page-badge').textContent, '可能看过');
  assert.deepEqual(panel.storage.data, original);
  assert.deepEqual([...new Set(panel.requests.map(request => request.type))].sort(), ['PAD_READ', 'READ_PAGE', 'RECORDS']);
  panel.setSnapshot({ ...raw, nameHint: null, jobHint: null, reason: '会话正在切换', token: 'query:2' });
  await panel.intervals[0]();
  assert.equal(panel.document.querySelector('#page-content .possible-list'), null);
  assert.equal(panel.document.getElementById('page-content').textContent.includes('华达新材料'), false);
  panel.setSnapshot({ ...raw, nameHint: '其他公司', token: 'query:3' });
  await panel.intervals[0]();
  assert.equal(panel.document.getElementById('page-badge').textContent, '简称查询');
  assert.match(panel.document.getElementById('page-content').textContent, /暂无名称相近的记录/);
  assert.doesNotMatch(panel.document.getElementById('page-content').textContent, /未记录|没看过|从未看过/);
});

test('content reader returns a query over a company page without automatic visits, rest writes or chat initiation', async () => {
  const { document, window } = parseHTML(chatMarkup());
  const before = document.toString();
  const messages = [];
  const runtime = { id: 'query-extension', onMessage: event(), async sendMessage(message) { messages.push(message); return { ok: true, documentId: 'query-doc' }; } };
  const context = vm.createContext({ document, URL, Date, console, chrome: { runtime }, location: { href: company().url }, crypto: { randomUUID: () => 'query-reader' }, MutationObserver: window.MutationObserver, setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {} });
  for (const file of ['core/identity.js', 'core/rest.js', 'core/parser.js', 'core/page-state.js', 'content.js']) vm.runInContext(source(file), context);
  await flush();
  let snapshot;
  runtime.onMessage.handlers[0]({ type: 'GET_PAGE' }, { id: runtime.id }, reply => { snapshot = reply; });
  assert.equal(snapshot.kind, 'query');
  assert.equal(snapshot.nameHint, '华达新材料');
  assert.equal(snapshot.current, null);
  assert.equal(messages.some(message => ['AUTO_COMPANY_VISIT', 'REST_SEEN', 'INITIATE_CHAT', 'CHAT_SENT'].includes(message.type)), false);
  assert.equal(document.toString(), before);
  context.BossTracker.reader.dispose();
});
