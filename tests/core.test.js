import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { api, company, ID_A, ID_B, memoryStorage } from './helpers.js';
const html = async name => parseHTML(await readFile(new URL(`fixtures/${name}.html`, import.meta.url), 'utf8')).document;
const doc = markup => parseHTML(markup).document;
test('identity canonicalizes query/hash and rejects names, generic pages, foreign URLs and protocols', () => {
  assert.deepEqual(api.companyIdentity(`/gongsi/${ID_A}.html?ka=job#company`), { key: `boss:${ID_A}`, url: company().url });
  for (const href of ['/gongsi/', '/gongsi/500qiang.html', '/gongsi/33.html', 'javascript:alert(1)', 'http://www.zhipin.com/gongsi/' + ID_A + '.html', 'https://evil.example/gongsi/' + ID_A + '.html']) assert.equal(api.companyIdentity(href), null);
  assert.equal(api.validCompany({ ...company(), key: `boss:${ID_B}` }), null);
});
test('company jobs routes use the same canonical identity as the company intro page', () => {
  const canonical = { key: `boss:${ID_A}`, url: company().url };
  assert.deepEqual(api.companyIdentity(`/gongsi/job/${ID_A}.html`), canonical);
  assert.deepEqual(api.companyIdentity(`/gongsi/job/160000/${ID_A}.html?ka=job#jobs`), canonical);
  for (const href of ['/gongsi/job/', `/gongsi/job/${ID_A}.html/`, `/gongsi/job/tag/${ID_A}.html`, `/gongsi/jobs/${ID_A}.html`, `https://evil.example/gongsi/job/${ID_A}.html`]) assert.equal(api.companyIdentity(href), null);
});
test('loaded list deduplicates by identity, keeps same-name companies separate, counts unknown and skips hidden/recommended', async () => {
  const document = await html('list');
  const before = document.toString();
  const page = api.parsePage(document, 'https://www.zhipin.com/web/geek/job');
  assert.equal(page.kind, 'list');
  assert.equal(page.companies.length, 2);
  assert.equal(page.unresolved, 1);
  assert.equal(page.companies[0].name, page.companies[1].name);
  assert.equal(document.toString(), before, 'parsing must leave original DOM unchanged');
  document.querySelector('ul').insertAdjacentHTML('beforeend', `<li class="job-card-wrapper"><a href="/gongsi/new-company-identity.html">新公司</a></li>`);
  assert.equal(api.parsePage(document, 'https://www.zhipin.com/web/geek/job').companies.length, 3);
});
test('clicked list card exposes only a unique company identity and skips anonymous/conflicting/action targets', async () => {
  const document = await html('list');
  const href = 'https://www.zhipin.com/web/geek/job';
  const cards = document.querySelectorAll('.job-card-wrapper');
  assert.deepEqual(api.validCompany(api.companyFromClick(cards[0].querySelector('a'), href)), { ...company(), name: '同名公司' });
  assert.deepEqual(api.validCompany(api.companyFromClick(cards[0], href)), { ...company(), name: '同名公司' });
  assert.equal(api.selectedJobFromClick(cards[0], href), 'job:synthetic-job-a');
  assert.deepEqual(api.validCompany(api.companyFromClick(cards[2].querySelector('a'), href)), { ...company(ID_B), name: '同名公司' });
  assert.equal(api.companyFromClick(cards[3].querySelector('a'), href), null, 'name-only card is not guessed');
  cards[0].insertAdjacentHTML('beforeend', `<a href="${company(ID_B).url}">冲突公司</a>`);
  assert.equal(api.companyFromClick(cards[0].querySelector('a'), href), null);
  cards[1].insertAdjacentHTML('beforeend', '<button>收藏</button>');
  assert.equal(api.companyFromClick(cards[1].querySelector('button'), href), null);
  const wrapped = doc(`<div class="job-card-wrap"><a class="job-name" href="/job_detail/wrapped.html">职位</a><a class="company-name" href="${company().url}">甲公司</a></div>`);
  const wrapper = wrapped.querySelector('.job-card-wrap');
  assert.equal(api.selectedJobFromClick(wrapper, href), 'job:wrapped');
  assert.deepEqual(api.validCompany(api.companyFromClick(wrapper, href)), { ...company(), name: '甲公司' });
});
test('detail identity comes only from company region, never recommendations or stale hidden detail', async () => {
  const document = await html('detail');
  const page = api.parsePage(document, 'https://www.zhipin.com/job_detail/synthetic.html');
  assert.equal(page.current.key, company().key);
  document.querySelector('.job-company').remove();
  assert.equal(api.parsePage(document, 'https://www.zhipin.com/job_detail/synthetic.html').current, null);
});
test('direct job detail keeps the sider company while ignoring selected-job links, view-all actions and hidden banner text', async () => {
  const document = await html('job-detail-sider');
  const page = api.parsePage(document, 'https://www.zhipin.com/job_detail/direct-job-a.html');
  assert.equal(page.kind, 'detail');
  assert.equal(page.detailType, 'job');
  assert.equal(page.subject, 'job:direct-job-a');
  assert.equal(page.current.key, company().key);
  assert.equal(page.current.name, '旭创科技');
  assert.equal(page.current.url, company().url);
});
test('direct job detail still refuses two different visible sider companies', () => {
  const base = 'https://www.zhipin.com/job_detail/direct-job-a.html';
  const document = doc(`
    <div class="job-box">
      <div class="sider-company">
        <div class="company-info">
          <a href="${company().url}" title="甲公司">甲公司</a>
          <a href="${company(ID_B).url}" title="乙公司">乙公司</a>
        </div>
      </div>
      <div class="job-detail"><h1>产品经理</h1></div>
    </div>
  `);
  assert.equal(api.parsePage(document, base).current, null);
});
test('conflicting company regions and name-only details are unknown, security gate never records', () => {
  const base = 'https://www.zhipin.com/job_detail/synthetic.html';
  const conflict = doc(`<div class="job-detail"><div class="job-company"><a href="${company().url}">甲</a><a href="${company(ID_B).url}">乙</a></div></div>`);
  assert.equal(api.parsePage(conflict, base).current, null);
  assert.equal(api.parsePage(doc('<div class="job-company">甲公司</div>'), base).current, null);
  assert.equal(api.parsePage(conflict, 'https://www.zhipin.com/web/passport/zp/security.html').current, null);
  assert.equal(api.parsePage(conflict, 'https://example.com').kind, 'outside');
});
test('company URL is identity only when current company heading has loaded', () => {
  const document = doc('<div class="company-info"><h1>甲公司</h1></div>');
  assert.equal(api.parsePage(document, company().url).current.key, company().key);
  assert.equal(api.parsePage(doc('<div></div>'), company().url).current, null);
});
test('company jobs tab keeps the same visit and ignores similar-job companies', async () => {
  const document = await html('company-jobs');
  const jobsHref = `https://www.zhipin.com/gongsi/job/${ID_A}.html`;
  const page = api.parsePage(document, jobsHref);
  assert.equal(page.kind, 'detail');
  assert.equal(page.detailType, 'company');
  assert.equal(page.source, 'company-page');
  assert.equal(page.current.key, company().key);
  assert.equal(page.current.url, company().url);
  assert.equal(page.current.name, '示例公司');

  const heading = document.querySelector('.company-banner h1');
  heading.remove();
  let href = company().url;
  const state = api.createPageState(() => api.parsePage(document, href), () => href, 'jobs-document');
  const introPending = state.refresh();
  assert.equal(introPending.current, null);
  assert.equal(introPending.detailType, 'company');
  href = jobsHref;
  const jobsPending = state.refresh();
  assert.equal(jobsPending.current, null);
  assert.equal(jobsPending.visitId, introPending.visitId);
  document.querySelector('.company-banner').insertAdjacentHTML('afterbegin', '<h1>示例公司</h1>');
  const ready = state.refresh();
  assert.equal(ready.current.key, company().key);
  assert.equal(ready.visitId, introPending.visitId);
  assert.ok(state.confirmVisit(ready.token, company().key, ready.visitId));
});
test('page tokens invalidate old identity on route change, ambiguity, same-page replacement and reload', () => {
  let href = 'https://www.zhipin.com/job_detail/a.html';
  let current = company();
  const state = api.createPageState(() => ({ kind: 'detail', current, companies: [], unresolved: 0 }), () => href, 'document-1');
  const first = state.refresh();
  assert.equal(state.refresh().token, first.token);
  assert.equal(state.confirm(first.token, first.current.key).key, company().key);
  href = 'https://www.zhipin.com/job_detail/b.html'; current = company(ID_B);
  assert.equal(state.confirm(first.token, first.current.key), null);
  const second = state.refresh(); current = null;
  assert.equal(state.confirm(second.token, second.current.key), null);
  const reloaded = api.createPageState(() => ({ kind: 'detail', current: company() }), () => first.href, 'document-2');
  assert.equal(reloaded.confirm(first.token, first.current.key), null);
  assert.equal(api.validateSnapshot(first, href), null);
});
test('parsing or status lookup never writes; explicit mark is idempotent and preserves first timestamp', async () => {
  const storage = memoryStorage();
  const repository = api.createRepository(storage, () => new Date('2026-10-10T16:01:00Z'));
  const page = api.parsePage(await html('detail'), 'https://www.zhipin.com/job_detail/a.html');
  assert.equal(api.companyStatus(page.current, await repository.list()).state, 'unrecorded');
  assert.deepEqual(storage.data, {});
  const first = await repository.mark(page.current);
  const duplicate = await repository.mark({ ...page.current, name: '新展示名' });
  assert.deepEqual(duplicate, first);
  assert.equal((await repository.list()).length, 1);
  const anotherJob = api.parsePage(await html('detail'), 'https://www.zhipin.com/job_detail/b.html');
  assert.equal(api.companyStatus(anotherJob.current, await repository.list()).state, 'seen');
});
test('SPA route switch with unchanged old DOM hides previous company until fresh identity loads', () => {
  let href = 'https://www.zhipin.com/job_detail/a.html';
  let current = company();
  const state = api.createPageState(() => ({ kind: 'detail', current, companies: [], unresolved: 0 }), () => href, 'spa');
  const first = state.refresh();
  href = 'https://www.zhipin.com/job_detail/b.html';
  const pending = state.refresh();
  assert.equal(pending.current, null);
  assert.equal(state.refresh().current, null);
  assert.equal(state.confirm(first.token, company().key), null);
  current = company(ID_B, '新公司');
  assert.equal(state.refresh().current.key, current.key);
});
test('concurrent marks are serialized without losing companies; repository recreation preserves stored data', async () => {
  const storage = memoryStorage();
  const repository = api.createRepository(storage);
  await Promise.all([repository.mark(company()), repository.mark(company(ID_B)), repository.mark(company())]);
  const restarted = api.createRepository(storage);
  assert.equal((await restarted.list()).length, 2);
  await restarted.remove(company().key);
  assert.equal(api.companyStatus(company(), await restarted.list()).state, 'unrecorded');
  assert.equal((await restarted.list()).length, 1);
});
test('read/write/remove failures never fabricate success or clear records and queue recovers after error', async () => {
  const storage = memoryStorage(); const repository = api.createRepository(storage);
  storage.fail('set'); await assert.rejects(repository.mark(company()), /保存失败/);
  assert.deepEqual(storage.data, {});
  storage.fail(null); await repository.mark(company());
  storage.fail('get'); await assert.rejects(repository.list(), /读取失败/);
  storage.fail('remove'); await assert.rejects(repository.remove(company().key), /撤销失败/);
  storage.fail(null); assert.equal((await repository.list()).length, 1);
  await assert.rejects(repository.mark({ name: '仅有名称' }), /无法识别/);
  storage.data[api.PREFIX + company(ID_B).key] = { key: company(ID_B).key };
  await assert.rejects(repository.list(), /格式异常/);
  assert.ok(storage.data[api.PREFIX + company().key]);
});
test('search normalizes text; CSV has BOM, quotes, formula protection, UTC timestamp and Shanghai date', () => {
  const records = [{ ...company(), name: '产品 "助手",公司', markedAt: '2026-10-10T16:01:00.000Z' }, { ...company(ID_B), name: 'ＡＩ公司', markedAt: '2026-10-10T00:00:00.000Z' }];
  assert.equal(api.searchRecords(records, 'ai')[0].name, 'ＡＩ公司');
  assert.equal(api.searchRecords(records, '  助手 ').length, 1);
  const csv = api.exportCsv(records);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('"产品 ""助手"",公司"'));
  assert.ok(csv.includes('2026-10-11'));
  assert.ok(csv.includes('2026-10-10T16:01:00.000Z'));
  assert.equal(api.localDateTime('2026-10-10T16:01:00.000Z'), '2026-10-11 00:01');
  assert.equal(api.localDateTime('2026-10-10T16:05:00.000Z'), '2026-10-11 00:05');
  for (const name of ['=SUM(1,2)', '+cmd', '-cmd', '@cmd', ' \t=cmd', '\tcmd']) assert.ok(api.csvCell(name).startsWith('"\''));
  assert.equal(api.csvCell('a\nb"c'), '"a\nb""c"');
});
test('fresh view covers current-tab first/manual visits and the 60-second new-record window', () => {
  const now = Date.parse('2026-11-04T10:00:00.000Z');
  const recent = { ...company(), markedAt: '2026-11-04T09:59:30.000Z' };
  const old = { ...company(), markedAt: '2026-11-04T09:00:00.000Z' };
  assert.equal(api.isFreshView(recent, null, now), true);
  assert.equal(api.isFreshView(recent, { key: company().key, state: 'first' }, now), true);
  assert.equal(api.isFreshView(old, { key: company().key, state: 'first' }, now), true);
  assert.equal(api.isFreshView(old, { key: company().key, state: 'manual' }, now), true);
  assert.equal(api.isFreshView(old, { key: company().key, state: 'prior' }, now), false);
  assert.equal(api.isFreshView(recent, { key: company(ID_B).key, state: 'first' }, now), true, 'recent new record stays green within 60s');
  assert.equal(api.isFreshView(old, { key: company(ID_B).key, state: 'first' }, now), false);
  assert.equal(api.isFreshView({ ...old, markedAt: 'not-a-date' }, { key: company().key, state: 'first' }, now), true);
  assert.equal(api.isFreshView({ ...old, markedAt: 'not-a-date' }, null, now), false);
  assert.equal(api.isRecentlyAdded(recent, now), true);
  assert.equal(api.isRecentlyAdded(old, now), false);
});
