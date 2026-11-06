import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { api, company, ID_B, memoryStorage } from './helpers.js';
const doc = markup => parseHTML(markup).document;
const named = (markup, value = company()) => api.companiesIn(doc(`<a href="${value.url}">${markup}</a>`), value.url)[0];
test('company names exclude structural action/hidden nodes without mutating DOM or stripping valid words', () => {
  for (const markup of [
    '汇川技术<button>收藏</button>',
    '<span class="company-name">汇川技术<span role="button">收藏</span></span>',
    '<span class="name">汇川技术<span class="collect">已收藏</span></span>',
    '汇川技术<span class="actions"><span>取消收藏</span></span>',
    '汇川技术<span hidden>收藏</span><script>噪声</script>'
  ]) {
    const document = doc(`<a href="${company().url}">${markup}</a>`); const before = document.toString();
    const result = api.companiesIn(document, company().url)[0];
    assert.equal(result.name, '汇川技术'); assert.equal(result.nameProof.name, '汇川技术');
    assert.equal(document.toString(), before);
  }
  assert.equal(named('收藏文化有限公司<button>收藏</button>').name, '收藏文化有限公司');
  assert.equal(named('收藏').name, '收藏');
  assert.equal(named('汇川技术收藏').name, '汇川技术收藏', 'unstructured legacy text is not guessed');
  assert.equal(named('汇川技术收藏').nameProof, undefined);
});
test('dedicated nodes/explicit company attrs win; tooltip operations, hidden names and conflicting names cannot prove corrections', () => {
  const parse = attributes => api.companiesIn(doc(`<a href="${company().url}" ${attributes}</a>`), company().url)[0];
  assert.equal(parse('title="无关提示"><span class="company-name">中寿众鑫</span><button>收藏</button>').name, '中寿众鑫');
  assert.equal(parse('data-company-name="可靠全称">品牌展示<button>收藏</button>').name, '可靠全称');
  assert.equal(parse('title="收藏">汇川技术<button>收藏</button>').name, '汇川技术');
  assert.equal(parse('title="汇川技术">汇川技术<button>收藏</button>').nameProof.kind, 'name-attribute');
  assert.equal(parse('title="收藏"><button>收藏</button>'), undefined, 'operation-only tooltip is not a company name');
  assert.equal(named('<span class="company-name" hidden>隐藏错误名</span><span class="name">可靠名称</span><button>收藏</button>').name, '可靠名称');
  assert.equal(named('<span class="name">甲公司</span><span class="company-name">乙公司</span>'), undefined);
  const repeated = doc(`<a href="${company().url}"><span class="name">甲公司</span></a><a href="${company().url}"><span class="name">乙公司</span></a><a href="${company().url}"><span class="name">乙公司</span></a>`);
  assert.equal(api.companiesIn(repeated, company().url)[0].nameProof, undefined);
});
test('company page headings and inline job association use clean names and retain exact identity', () => {
  const own = doc('<div class="company-info"><h1>收藏文化有限公司<button>收藏</button></h1></div>');
  const current = api.parsePage(own, company().url).current;
  assert.equal(current.name, '收藏文化有限公司'); assert.equal(current.key, company().key);
  const detail = doc(`<div class="job-detail" data-job-id="sample"></div><div class="job-card-wrapper"><a href="/job_detail/sample.html">职位</a><a href="${company().url}">中寿众鑫<span class="favorite">收藏</span></a></div>`);
  const linked = api.parsePage(detail, 'https://www.zhipin.com/web/geek/job').current;
  assert.equal(linked.name, '中寿众鑫'); assert.equal(linked.key, company().key);
});
test('proven name correction updates only existing name, keeps identity/first time, search/CSV and unrelated pad untouched', async () => {
  const storage = memoryStorage(); const repository = api.createRepository(storage);
  const original = { ...company(undefined, '汇川技术收藏'), url: company().url + '?ka=legacy', markedAt: '2026-10-01T00:00:00.000Z' };
  storage.data[api.PREFIX + original.key] = original;
  storage.data[api.PAD_KEY] = { text: '私人话术', height: 160 };
  const evidence = named('汇川技术<button>收藏</button>'); let verifications = 0;
  assert.equal(await repository.correctName(evidence, async () => { verifications++; }), true);
  assert.equal(verifications, 1);
  assert.deepEqual(storage.data[api.PREFIX + original.key], { ...original, name: '汇川技术' });
  assert.equal(await repository.correctName(evidence), false);
  const records = await repository.list(); assert.equal(records.length, 1);
  assert.equal(api.searchRecords(records, '汇川技术收藏').length, 0); assert.equal(api.searchRecords(records, '汇川技术').length, 1);
  const csv = api.exportCsv(records); assert.match(csv, /汇川技术/); assert.doesNotMatch(csv, /汇川技术收藏|私人话术|nameProof/); assert.match(csv, /2026-10-01T00:00:00.000Z/);
  assert.equal(storage.data[api.PAD_KEY].text, '私人话术');
  const different = named('<span class="name">另一家</span>', company(ID_B));
  assert.equal(await repository.correctName(different), false, 'unknown company is never recorded');
  await repository.remove(original.key); assert.equal(await repository.correctName(evidence), false, 'undo is never recreated by correction');
});
test('missing/invalid evidence, page changes and storage failure preserve old records; existing visit may correct name without resetting time', async () => {
  const storage = memoryStorage(); const repository = api.createRepository(storage);
  const original = { ...company(undefined, '汇川技术收藏'), markedAt: '2026-10-01T00:00:00.000Z' };
  storage.data[api.PREFIX + original.key] = original;
  assert.equal(await repository.correctName(company(undefined, '凭名称猜测')), false);
  const evidence = named('<span class="company-name">汇川技术</span><button>收藏</button>');
  assert.equal(await repository.correctName({ ...evidence, key: company(ID_B).key }), false);
  assert.equal(await repository.correctName({ ...evidence, nameProof: { kind: 'name-node', name: '错误' } }), false);
  await assert.rejects(repository.correctName(evidence, async () => { throw new Error('page changed'); }), /page changed/);
  assert.deepEqual(storage.data[api.PREFIX + original.key], original);
  storage.fail('set'); await assert.rejects(repository.correctName(evidence), /保存失败/); storage.fail(null);
  assert.deepEqual(storage.data[api.PREFIX + original.key], original);
  const result = await repository.visit(evidence);
  assert.equal(result.existed, true); assert.equal(result.record.name, '汇川技术'); assert.equal(result.record.markedAt, original.markedAt);
});
test('same-visit name refresh preserves first/suppressed states and never resurrects an undone company', async () => {
  const storage = memoryStorage(); const session = memoryStorage();
  const repository = api.createRepository(storage); const visits = api.createVisits(repository, session);
  const snapshot = { visitId: 'same:1', current: company(undefined, '汇川技术收藏') };
  const first = await visits.open(7, snapshot, async () => {});
  const proven = { ...snapshot, current: named('汇川技术<button>收藏</button>') };
  assert.equal((await visits.open(7, proven, async () => {})).state, 'first');
  assert.equal((await repository.list())[0].markedAt, first.markedAt); assert.equal((await repository.list())[0].name, '汇川技术');
  await visits.remove(snapshot.current.key);
  assert.equal((await visits.open(7, proven, async () => {})).state, 'suppressed'); assert.deepEqual(storage.data, {});
});
