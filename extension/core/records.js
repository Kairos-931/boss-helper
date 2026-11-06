(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const PREFIX = 'company:';
  function reliableName(value) {
    return ['name-node', 'name-attribute', 'filtered-link', 'company-heading'].includes(value?.nameProof?.kind) && value.nameProof.name === value.name && api.validCompany(value)?.name === value.name;
  }
  function validRecord(value) {
    const company = api.validCompany(value);
    if (!company || typeof value.markedAt !== 'string' || !Number.isFinite(Date.parse(value.markedAt))) return null;
    const contacted = typeof value.contactedAt === 'string' && Number.isFinite(Date.parse(value.contactedAt))
      && ['auto', 'manual'].includes(value.contactSource) ? { contactedAt: value.contactedAt, contactSource: value.contactSource } : {};
    const restValue = api.validRest?.(value.rest) || null;
    const rest = restValue ? { rest: restValue, restUpdatedAt: typeof value.restUpdatedAt === 'string' ? value.restUpdatedAt : '' } : {};
    return { ...company, markedAt: value.markedAt, ...contacted, ...rest };
  }
  function createRepository(storage, clock = () => new Date()) {
    let queue = Promise.resolve();
    function serial(task) {
      const operation = queue.then(task);
      queue = operation.catch(() => {});
      return operation;
    }
    async function list() {
      const values = await storage.get(null);
      const records = [];
      for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith(PREFIX)) continue;
        const record = validRecord(value);
        if (!record || key !== PREFIX + record.key) throw new Error('记录格式异常，未修改原数据。请导出可用记录前联系开发排查。');
        records.push(record);
      }
      return records.sort((a, b) => b.markedAt.localeCompare(a.markedAt) || a.key.localeCompare(b.key));
    }
    async function correctExisting(value, existing, verify, original = existing) {
      if (!reliableName(value) || value.name === existing.name) return existing;
      await verify();
      const record = { ...original, name: value.name };
      await storage.set({ [PREFIX + existing.key]: record });
      return validRecord(record);
    }
    function correctName(value, verify = async () => {}) {
      return serial(async () => {
        if (!reliableName(value)) return false;
        const company = api.validCompany(value);
        const original = (await storage.get(PREFIX + company.key))[PREFIX + company.key];
        if (original === undefined) return false;
        const existing = validRecord(original);
        if (!existing || existing.key !== company.key) throw new Error('原记录格式异常，未更改名称。');
        const corrected = await correctExisting(value, existing, verify, original);
        return corrected.name !== existing.name;
      });
    }
    function visit(value, verify = async () => {}) {
      return serial(async () => {
        const company = api.validCompany(value);
        if (!company) throw new Error('无法识别公司，未保存。');
        const storageKey = PREFIX + company.key;
        const result = await storage.get(storageKey);
        if (result[storageKey] !== undefined) {
          const existing = validRecord(result[storageKey]);
          if (!existing || existing.key !== company.key) throw new Error('原记录格式异常，未覆盖数据。');
          return { record: await correctExisting(value, existing, verify, result[storageKey]), existed: true };
        }
        const record = { ...company, markedAt: clock().toISOString() };
        await verify();
        await storage.set({ [storageKey]: record });
        return { record, existed: false };
      });
    }
    async function mark(value) { return (await visit(value)).record; }
  function markContacted(value, source, verify = async () => {}) {
    return serial(async () => {
      if (!['auto', 'manual'].includes(source)) throw new Error('沟通来源无效，未保存。');
      const company = api.validCompany(value);
      if (!company) throw new Error('无法识别公司，未保存。');
      const storageKey = PREFIX + company.key;
      const result = await storage.get(storageKey);
      const at = clock().toISOString();
      if (result[storageKey] !== undefined) {
        const existing = validRecord(result[storageKey]);
        if (!existing || existing.key !== company.key) throw new Error('原记录格式异常，未覆盖数据。');
        const updated = {
          ...result[storageKey],
          ...(existing.contactedAt ? {} : { contactedAt: at, contactSource: source }),
          ...(reliableName(value) && value.name !== existing.name ? { name: value.name } : {})
        };
        await verify();
        await storage.set({ [storageKey]: updated });
        return validRecord(updated);
      }
      const record = { ...company, markedAt: at, contactedAt: at, contactSource: source };
      await verify();
      await storage.set({ [storageKey]: record });
      return validRecord(record);
    });
  }
  function setRest(key, rest) {
    return serial(async () => {
      if (!api.validRest(rest)) throw new Error('休息制度无效，未保存。');
      if (typeof key !== 'string' || !key.startsWith('boss:')) throw new Error('公司记录无效，未保存。');
      const storageKey = PREFIX + key;
      const result = await storage.get(storageKey);
      if (result[storageKey] === undefined) return null;
      const existing = validRecord(result[storageKey]);
      if (!existing || existing.key !== key) throw new Error('原记录格式异常，未覆盖数据。');
      if (existing.rest === rest) return existing;
      const updated = { ...result[storageKey], rest, restUpdatedAt: clock().toISOString() };
      await storage.set({ [storageKey]: updated });
      return validRecord(updated);
    });
  }
    function cancelContacted(key) {
      return serial(async () => {
        if (typeof key !== 'string' || !key.startsWith('boss:')) throw new Error('公司记录无效，未取消沟通标记。');
        const storageKey = PREFIX + key;
        const result = await storage.get(storageKey);
        const original = result[storageKey];
        if (original === undefined) return null;
        const existing = validRecord(original);
        if (!existing || existing.key !== key) throw new Error('原记录格式异常，未取消沟通标记。');
        if (!Object.hasOwn(original, 'contactedAt') && !Object.hasOwn(original, 'contactSource')) return existing;
        const updated = { ...original };
        delete updated.contactedAt;
        delete updated.contactSource;
        await storage.set({ [storageKey]: updated });
        return validRecord(updated);
      });
    }
    function remove(key) {
      return serial(async () => {
        if (typeof key !== 'string' || !key.startsWith('boss:')) throw new Error('公司记录无效，未撤销。');
        await storage.remove(PREFIX + key);
      });
    }
    return { list, mark, visit, markContacted, cancelContacted, setRest, remove, correctName };
  }
  function searchRecords(records, query = '') {
    const needle = String(query).normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
    return records.filter(record => record.name.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(needle));
  }
  function companyStatus(company, records) {
    if (!api.validCompany(company)) return { state: 'unknown', record: null };
    const record = records.find(value => value.key === company.key);
    return { state: record ? 'seen' : 'unrecorded', record: record || null };
  }
  const RECENT_VIEW_MS = 60000;
  function isFreshView(record, visit = null, now = Date.now()) {
    if (!record?.key) return false;
    if (visit && visit.key === record.key && ['first', 'manual'].includes(visit.state)) return true;
    return isRecentlyAdded(record, now);
  }
  function isRecentlyAdded(record, now = Date.now()) {
    const markedAt = Date.parse(record?.markedAt);
    return Number.isFinite(markedAt) && Math.abs(now - markedAt) < RECENT_VIEW_MS;
  }
  function normalizeNameKey(value) {
    return api.cleanName(value).normalize('NFKC').toLowerCase()
      .replace(/[\s\p{P}]/gu, '').replace(/招聘$/, '')
      .replace(/(?:股份有限责任公司|股份有限公司|有限责任公司|有限公司)$/, '');
  }
  function oneEditApart(left, right) {
    if (Math.abs(left.length - right.length) > 1) return false;
    let leftIndex = 0;
    let rightIndex = 0;
    let edits = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
      if (left[leftIndex] === right[rightIndex]) { leftIndex++; rightIndex++; continue; }
      if (++edits > 1) return false;
      if (left.length >= right.length) leftIndex++;
      if (right.length >= left.length) rightIndex++;
    }
    return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
  }
  function fuzzyMatchRecords(records, hint) {
    const hintCore = normalizeNameKey(hint);
    const generic = new Set(['公司', '集团', '科技', '电子', '新材料', '人力', '招聘', '有限责任公司', '有限公司']);
    if (!records?.length || hintCore.length < 2 || generic.has(hintCore) || (/^[a-z0-9]+$/.test(hintCore) && hintCore.length < 3)) return [];
    const matches = [];
    for (const record of records) {
      const core = normalizeNameKey(record.name);
      if (core.length < 2 || generic.has(core)) continue;
      if (core === hintCore) matches.push({ record, rank: 0 });
      else if ((core.includes(hintCore) || hintCore.includes(core)) && (!/^[a-z0-9]+$/.test(core) || core.length >= 3)) matches.push({ record, rank: 1 });
      else if (Math.min(core.length, hintCore.length) >= 4 && oneEditApart(core, hintCore)) matches.push({ record, rank: 2 });
    }
    return matches
      .sort((a, b) => a.rank - b.rank || b.record.markedAt.localeCompare(a.record.markedAt))
      .slice(0, 3)
      .map(match => match.record);
  }
  function localDate(value) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
    const get = type => parts.find(part => part.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  function localDateTime(value) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
    const get = type => parts.find(part => part.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  }
  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }
  function exportCsv(records) {
    const rows = [['公司名称', '公司标识', '公司链接', '首次标记时间（UTC）', '标记日期（上海）', '首次沟通时间（UTC）', '沟通来源', '休息制度']];
    const restLabel = value => api.restLabel?.(value) || '';
    for (const record of records) rows.push([record.name, record.key, record.url, record.markedAt, localDate(record.markedAt), record.contactedAt ?? '', record.contactSource ?? '', restLabel(record.rest)]);
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  Object.assign(api, { PREFIX, RECENT_VIEW_MS, validRecord, createRepository, searchRecords, companyStatus, isFreshView, isRecentlyAdded, fuzzyMatchRecords, normalizeNameKey, localDate, localDateTime, csvCell, exportCsv });
})();
