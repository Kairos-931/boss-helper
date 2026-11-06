import './core/identity.js';
import './core/rest.js';
import './core/settings.js';
import './core/page-state.js';
import './core/records.js';
import './core/visits.js';
import './core/pad.js';
import './pad.js';
const api = globalThis.BossTracker;
const byId = id => document.getElementById(id);
let records = null;
let page = null;
let recentVisit = null;
let tabId = null;
let view = 'loading';
let request = 0;
let recordRequest = 0;
let operation = false;
let dataError = false;
let currentSignature = '';
let retryAction = null;
let pendingMark = null;
let manualResult = null;
let recordsExpanded = false;
let reconnecting = false;
let collapsing = false;
let lastNameSync = '';
const panelWindowId = (await chrome.windows.getCurrent()).id;
byId('version').textContent = chrome.runtime.getManifest().version;
const collapseOnCopy = byId('pad-collapse');
const collapseOnCopyStatus = byId('pad-collapse-status');
const listClickView = byId('list-click-view');
const listClickViewStatus = byId('list-click-view-status');
let collapseOnCopyEnabled = false;
let listClickViewEnabled = false;
async function loadCollapseOnCopy() {
  try {
    const stored = await chrome.storage.local.get(api.PAD_COLLAPSE_KEY);
    collapseOnCopyEnabled = stored[api.PAD_COLLAPSE_KEY] === true;
  } catch {
    collapseOnCopyEnabled = false;
    collapseOnCopyStatus.textContent = '开关读取失败，已按关闭处理；可重新切换。';
  }
  collapseOnCopy.checked = collapseOnCopyEnabled;
}
async function saveCollapseOnCopy(next) {
  collapseOnCopy.disabled = true;
  collapseOnCopyStatus.textContent = '';
  try {
    await chrome.storage.local.set({ [api.PAD_COLLAPSE_KEY]: next });
    collapseOnCopyEnabled = next;
    collapseOnCopy.checked = next;
  } catch (error) {
    collapseOnCopy.checked = collapseOnCopyEnabled;
    collapseOnCopyStatus.textContent = `开关未保存：${error.message}，请再切换一次。`;
  } finally { collapseOnCopy.disabled = false; }
}
collapseOnCopy.addEventListener('change', () => saveCollapseOnCopy(collapseOnCopy.checked));
async function loadListClickView() {
  try {
    const stored = await chrome.storage.local.get(api.LIST_CLICK_VIEW_KEY);
    listClickViewEnabled = api.listClickViewEnabled(stored[api.LIST_CLICK_VIEW_KEY]);
  } catch {
    listClickViewEnabled = false;
    listClickViewStatus.textContent = '开关读取失败，已按关闭处理；可重新切换。';
  }
  listClickView.checked = listClickViewEnabled;
}
async function saveListClickView(next) {
  listClickView.disabled = true;
  listClickViewStatus.textContent = '';
  try {
    await chrome.storage.local.set({ [api.LIST_CLICK_VIEW_KEY]: next });
    listClickViewEnabled = next;
    listClickView.checked = next;
    renderPage();
  } catch (error) {
    listClickView.checked = listClickViewEnabled;
    listClickViewStatus.textContent = `开关未保存：${error.message}，请再切换一次。`;
  } finally { listClickView.disabled = false; }
}
listClickView.addEventListener('change', () => saveListClickView(listClickView.checked));
await Promise.all([loadCollapseOnCopy(), loadListClickView()]);
api.setupPad({ document, chrome, clipboard: navigator.clipboard, onCopied: () => { if (collapseOnCopyEnabled) collapseFloating(); } });
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function message(payload) {
  const reply = await chrome.runtime.sendMessage(payload);
  if (!reply?.ok) throw Object.assign(new Error(reply?.error || '助手连接失败，请重试。'), { code: reply?.code, target: reply?.target });
  return reply;
}
function feedback(text, error = false, retry = null, retryLabel = '重试') {
  const node = byId('feedback');
  node.textContent = text;
  node.className = error ? 'error' : '';
  node.hidden = !text;
  retryAction = retry;
  byId('retry').hidden = !retry;
  byId('retry').textContent = retryLabel;
}
function badge(text, state = '') {
  byId('page-badge').textContent = text;
  byId('page-badge').className = `badge ${state}`;
}
function renderNameQuery(content) {
  const matches = api.fuzzyMatchRecords(records, page.nameHint);
  badge(matches.length ? '可能看过' : '简称查询', matches.length ? 'possible' : '');
  content.append(element('div', page.nameHint, 'company'));
  if (page.jobHint) content.append(element('p', `当前岗位：${page.jobHint}`, 'muted'));
  if (!matches.length) {
    content.append(element('p', '暂无名称相近的记录。', 'muted'));
    return;
  }
  content.closest('section').classList.add('possible-warning');
  content.append(element('p', '这些记录的名称相近，请核对是否同一家公司。', 'muted'));
  const list = element('ul', undefined, 'possible-list');
  for (const record of matches) {
    const item = element('li');
    const row = element('div', undefined, 'row-top');
    const link = element('a', record.name, 'row-name');
    link.href = record.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    row.append(link, element('span', '可能看过', 'badge possible'));
    item.append(row, element('small', `首次记录：${api.localDateTime(record.markedAt)}`, 'record-date'));
    if (record.contactedAt) item.append(element('span', '该记录已标记沟通', 'badge contacted'));
    list.append(item);
  }
  content.append(list);
}
function renderPage() {
  const content = byId('page-content');
  content.closest('section').classList.remove('history-warning', 'possible-warning');
  content.replaceChildren();
  if (view === 'loading') { badge('识别中'); content.append(element('p', '正在读取当前页面…', 'muted')); return; }
  if (view === 'outside') { badge('未连接'); content.append(element('p', '请切换到 BOSS 直聘页面；这里仍可查看和导出已有记录。', 'muted')); return; }
  if (view === 'unavailable') { badge('无法识别', 'unknown'); content.append(element('p', '暂时无法读取页面。请点击上方“重新读取”，保留当前职位与位置。', 'muted')); return; }
  if (dataError || records === null) { badge('记录不可用', 'unknown'); content.append(element('p', '本地记录读取失败，暂不能判断是否看过。请点击重试。', 'muted')); return; }
  if (page?.kind === 'list') {
    const seen = page.companies.map(company => ({ company, ...api.companyStatus(company, records) })).filter(value => value.state === 'seen');
    if (!page.companies.length) badge('无法识别', 'unknown');
    else badge(`已看过 ${seen.length} 家`, seen.length ? 'seen' : '');
    content.append(element('p', `已识别当前列表 ${page.companies.length} 家公司。`, 'muted'));
    content.append(element('p', listClickViewEnabled ? '“点击职位条目即记看过”已开启；点击可唯一识别公司的条目会记录。' : '开启上方开关后，点击可唯一识别公司的职位条目会记为此看过。', 'muted'));
    if (page.unresolved) content.append(element('p', `另有 ${page.unresolved} 个职位卡片无法识别，未参与查重。`, 'muted'));
    if (!seen.length) content.append(element('p', page.companies.length ? '已识别公司中暂无看过的记录。展开职位后可主动标记。' : '当前列表缺少可靠公司链接，暂无法查重。', 'muted'));
    const list = element('ul');
    for (const value of seen) {
      const item = element('li');
      const nameRow = element('div', undefined, 'row-top');
      nameRow.append(element('div', value.company.name, 'row-name'));
      if (value.record.rest && value.record.rest !== 'double') nameRow.append(element('span', api.restLabel(value.record.rest), 'rest-tag'));
      item.append(nameRow, element('small', `${value.record.contactedAt ? '已沟通 · ' : '已看过 · '}${api.localDateTime(value.record.contactedAt || value.record.markedAt)}`, 'record-date'));
      list.append(item);
    }
    content.append(list);
    return;
  }
  const status = api.companyStatus(page?.current, records);
  if (status.state === 'unknown' || (page?.detailType === 'job' && !['job-card-match', 'job-company-link'].includes(page.source))) {
    if (page?.nameHint) { renderNameQuery(content); return; }
    badge('无法识别', 'unknown');
    content.append(element('p', page?.reason || '当前页面缺少可靠公司信息，暂不能记录。', 'muted'));
    return;
  }
  content.append(element('div', page.current.name, 'company'));
  if (page.detailType === 'company' && page.rest && page.rest !== 'double') {
    content.append(element('p', `注意：休息制度为${api.restLabel(page.rest)}。`, 'rest-warn'));
  }
  function historical(markedAt) {
    if (status.record?.contactedAt) {
      badge('已沟通', 'contacted');
      content.closest('section').classList.add('history-warning');
      content.append(element('p', '你已沟通过这家公司', 'history-message'), element('p', `首次沟通：${api.localDateTime(status.record.contactedAt)} · 首次查看：${api.localDateTime(markedAt)}`, 'history-date'));
      return;
    }
    badge('之前已看过', 'historical');
    content.closest('section').classList.add('history-warning');
    content.append(element('p', '这家公司你之前看过', 'history-message'), element('p', `首次记录：${api.localDateTime(markedAt)}`, 'history-date'));
  }
  if (page.detailType === 'company') {
    const history = page.history;
    if (!history) { badge('正在查重'); content.append(element('p', '公司身份已确认，正在查询并记录本次查看…', 'muted')); }
    else if (history.state === 'suppressed') { badge('本次已撤销'); content.append(element('p', '本次打开不会重新记录；离开后再进入公司页可重新记录。', 'muted')); }
    else if (history.state === 'error') {
      badge(history.recoveryBlocked ? '暂未自动记录' : '记录失败', 'unknown'); content.append(element('p', history.error || '自动记录失败，未确认保存成功。', 'muted'));
      if (history.recoveryBlocked) return;
      const retry = element('button', '重试记录', 'secondary');
      retry.addEventListener('click', async () => { try { await chrome.tabs.sendMessage(tabId, { type: 'RETRY_VISIT' }); refreshPage(); } catch { feedback('连接已中断，请刷新 BOSS 后重试。', true); } });
      content.append(retry);
    } else {
      const fresh = status.record && api.isFreshView(status.record, recentVisit);
      if (!fresh) historical(history.markedAt);
      else if (status.record.contactedAt) {
        badge('本次已沟通', 'seen');
        content.append(element('p', `首次查看：${api.localDateTime(history.markedAt)} · 首次沟通：${api.localDateTime(status.record.contactedAt)}`, 'muted'));
      } else {
        badge(history.state === 'first' ? '首次查看，已记录' : '本次已记录', 'seen');
        content.append(element('p', `首次记录：${api.localDateTime(history.markedAt)}`, 'muted'));
      }
      if (history.recoveryBlocked) content.append(element('p', '连接已恢复，本次查看状态无法确认，暂未自动记录。离开后再进入公司页可记录。', 'muted'));
    }
  } else {
    const isPending = pendingMark?.visitId === page.visitId && pendingMark?.key === page.current.key && pendingMark?.tabId === tabId;
    const justMarked = status.record && page.history?.state === 'manual';
    const fresh = status.record && api.isFreshView(status.record, recentVisit);
    if (isPending) { badge('正在保存'); content.append(element('p', '正在记录本次查看…', 'muted')); }
    else if (fresh && status.record.contactedAt) {
      badge('本次已沟通', 'seen');
      content.append(element('p', `首次查看：${api.localDateTime(status.record.markedAt)} · 首次沟通：${api.localDateTime(status.record.contactedAt)}`, 'muted'));
    }
    else if (justMarked) { badge('已记录本次查看', 'seen'); content.append(element('p', `首次记录：${api.localDateTime(status.record.markedAt)}`, 'muted')); }
    else if (fresh) { badge('本次已记录', 'seen'); content.append(element('p', `首次记录：${api.localDateTime(status.record.markedAt)}`, 'muted')); }
    else if (status.record?.contactedAt) historical(status.record.markedAt);
    else if (status.record) historical(status.record.markedAt);
    else {
      badge('未记录');
      content.append(element('p', page.history?.state === 'suppressed' ? '本次已撤销，可以再次点击记录。' : listClickViewEnabled ? '可直接标记，或在结果列表点击该职位条目自动记录。' : '展开职位不会自动记录。你可以主动标记这家公司。', 'muted'));
    }
    if (!status.record || isPending) {
      const context = { tabId, windowId: panelWindowId, href: page.href, token: page.token, visitId: page.visitId, key: page.current.key };
      const button = element('button', isPending ? '正在保存…' : '标记已查看', 'mark');
      button.disabled = operation || !page.visitId;
      button.addEventListener('click', () => markJob(context));
      content.append(button);
    }
  }
  if (!(page.detailType === 'company' && page.history?.state === 'suppressed') && !status.record?.contactedAt) {
    const contact = element('button', '标记已沟通', 'secondary');
    contact.disabled = operation;
    contact.addEventListener('click', () => updateContacted(page.current, true));
    content.append(contact);
  }
}
function renderRecords() {
  const list = byId('record-list');
  const toggle = byId('records-toggle');
  toggle.hidden = true;
  list.replaceChildren();
  byId('record-count').textContent = records?.length ?? '—';
  byId('export').disabled = !records?.length || dataError || operation;
  if (dataError || records === null) { list.append(element('p', '记录暂不可用，请点击重试。', 'muted')); return; }
  const matching = api.searchRecords(records, byId('search').value);
  if (!matching.length) { list.append(element('p', records.length ? '没有匹配的公司。' : '还没有记录。可在职位详情主动标记，或进入公司页自动记录。', 'muted')); return; }
  const ul = element('ul');
  const searching = Boolean(byId('search').value.normalize('NFKC').trim());
  const shown = searching || recordsExpanded ? matching : matching.slice(0, 3);
  if (!searching && matching.length > 3) {
    toggle.hidden = false;
    toggle.textContent = recordsExpanded ? '收起' : `展开全部（${records.length}）`;
    toggle.setAttribute('aria-expanded', String(recordsExpanded));
  }
  for (const record of shown) {
    const li = element('li');
    const row = element('div', undefined, 'row-top');
    const link = element('a', record.name, 'row-name');
    link.href = record.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const button = element('button', '撤销', 'text-button undo');
    button.disabled = operation;
    button.setAttribute('aria-label', `撤销 ${record.name} 的看过记录`);
    button.addEventListener('click', () => remove(record));
    row.append(link);
    if (record.contactedAt) row.append(element('span', '已沟通', 'badge contacted'));
    if (record.rest && record.rest !== 'double') row.append(element('span', api.restLabel(record.rest), 'rest-tag'));
    const contacted = Boolean(record.contactedAt);
    const contact = element('button', contacted ? '取消已沟通' : '标记已沟通', `text-button ${contacted ? 'cancel-contacted' : 'mark-contacted'}`);
    contact.disabled = operation;
    contact.setAttribute('aria-label', contacted ? `取消 ${record.name} 的已沟通标记，保留已查看记录` : `标记 ${record.name} 已沟通`);
    contact.addEventListener('click', () => updateContacted(record, !contacted));
    row.append(contact);
    row.append(button);
    const dates = [`首次标记：${api.localDateTime(record.markedAt)}`];
    if (record.contactedAt) dates.push(`首次沟通：${api.localDateTime(record.contactedAt)}`);
    li.append(row, element('small', dates.join(' · '), 'record-date'));
    ul.append(li);
  }
  list.append(ul);
}
function render() { renderPage(); renderRecords(); }
async function loadRecords() {
  const ticket = ++recordRequest;
  try {
    const reply = await message({ type: 'RECORDS' });
    if (ticket !== recordRequest) return;
    records = reply.records;
    dataError = false;
    render();
  } catch (error) {
    if (ticket !== recordRequest) return;
    dataError = true;
    feedback(`读取记录失败：${error.message}`, true, loadRecords);
    render();
  }
}
async function refreshPage(reset = false) {
  if (reconnecting) return;
  const ticket = ++request;
  if (reset) { page = null; view = 'loading'; currentSignature = ''; renderPage(); }
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId: panelWindowId });
    if (ticket !== request) return;
    const active = tabs[0];
    if (tabId !== active?.id) { page = null; currentSignature = ''; feedback(''); }
    tabId = active?.id ?? null;
    if (!active || !api.isBossPage(active.url)) { page = null; view = 'outside'; renderPage(); return; }
    if (active.status === 'loading') { page = null; view = 'loading'; renderPage(); return; }
    const raw = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE' });
    if (ticket !== request) return;
    // Check again after the content response: a tab switch must never publish the old company.
    const latest = (await chrome.tabs.query({ active: true, windowId: panelWindowId }))[0];
    if (ticket !== request) return;
    if (latest?.id !== active.id || latest?.url !== active.url) { refreshPage(true); return; }
    const snapshot = api.validateSnapshot(raw, latest.url);
    if (!snapshot) throw new Error('页面信息已变化');
    if (snapshot.history?.state === 'suppressed') manualResult = null;
    else if (manualResult?.tabId === tabId && manualResult.visitId === snapshot.visitId && manualResult.key === snapshot.current?.key) snapshot.history = manualResult.history;
    else if (manualResult) manualResult = null;
    let nextRecentVisit = null;
    if (snapshot.detailType === 'job' && tabId !== null) {
      try {
        const visitKey = api.VISIT_PREFIX + tabId;
        nextRecentVisit = (await chrome.storage.session?.get(visitKey))?.[visitKey] || null;
      } catch { nextRecentVisit = null; }
    }
    if (ticket !== request) return;
    const recordForFreshness = snapshot.current && records ? records.find(value => value.key === snapshot.current.key) : null;
    const freshForLayout = snapshot.detailType === 'job' && !!recordForFreshness && api.isFreshView(recordForFreshness, nextRecentVisit);
    page = snapshot;
    view = 'ready';
    recentVisit = nextRecentVisit;
    syncCompanyNames(raw, latest);
    const signature = JSON.stringify([snapshot, records, dataError, recentVisit, freshForLayout]);
    if (signature !== currentSignature) { currentSignature = signature; renderPage(); }
  } catch {
    if (ticket !== request) return;
    page = null; view = 'unavailable'; currentSignature = ''; renderPage();
  }
}
function syncCompanyNames(raw, active, force = false) {
  if (!raw.current?.nameProof && !raw.companies?.some(company => company.nameProof)) return;
  const signature = JSON.stringify([active.id, raw.href, raw.token]);
  if (!force && signature === lastNameSync) return;
  lastNameSync = signature;
  message({ type: 'SYNC_COMPANY_NAMES', tabId: active.id, windowId: panelWindowId, href: raw.href, token: raw.token }).catch(error => {
    if (tabId === active.id && page?.token === raw.token) feedback(`公司名称暂未更新：${error.message}`, true, () => syncCompanyNames(raw, active, true));
  });
}
async function reconnectPage(expected = null) {
  if (reconnecting) return false;
  reconnecting = true; ++request;
  const button = byId('reconnect');
  button.disabled = true; button.textContent = '重新读取中…';
  page = null; view = 'loading'; renderPage();
  try {
    const active = (await chrome.tabs.query({ active: true, windowId: panelWindowId }))[0];
    if (!active || !api.isBossPage(active.url)) throw new Error('请先切换到BOSS页面，再重新读取。');
    if (Number.isInteger(expected?.tabId) && (expected.tabId !== active.id || expected.href !== active.url)) throw new Error('页面已切换，请在当前页面重新点击收起。');
    const result = await message({ type: 'READ_PAGE', tabId: active.id, windowId: panelWindowId, href: active.url });
    const latest = (await chrome.tabs.query({ active: true, windowId: panelWindowId }))[0];
    if (latest?.id !== active.id || latest?.url !== active.url || latest.status === 'loading') throw new Error('页面已切换，请在当前页面再次点击重新读取。');
    const snapshot = api.validateSnapshot(result.snapshot, latest.url);
    if (!snapshot) throw new Error('页面读取信息不完整，请再次重新读取。');
    tabId = latest.id; page = snapshot; view = 'ready'; currentSignature = '';
    syncCompanyNames(result.snapshot, latest);
    if (manualResult?.visitId !== snapshot.visitId) manualResult = null;
    renderPage();
    feedback(result.recovered ? '页面读取连接已恢复。' : '已重新读取当前页面。');
    return true;
  } catch (error) {
    page = null; view = 'unavailable'; renderPage(); feedback(`重新读取失败：${error.message}`, true);
    return false;
  } finally { reconnecting = false; button.disabled = false; button.textContent = '重新读取'; }
}
byId('reconnect').addEventListener('click', reconnectPage);
async function collapseFloating(target = null, recover = false) {
  if (collapsing || reconnecting) return;
  collapsing = true;
  const button = byId('collapse-floating');
  button.disabled = true;
  try {
    if (recover && !await reconnectPage(target)) {
      feedback(byId('feedback').textContent, true, () => collapseFloating(target, true), '重新读取并收起');
      return;
    }
    await message({ type: 'FLOAT_COLLAPSE', windowId: panelWindowId, ...(target || {}) });
  } catch (error) {
    const needsRecovery = error.code === 'FLOAT_RECONNECT_REQUIRED';
    feedback(`暂未收起：${error.message}`, true, needsRecovery ? () => collapseFloating(error.target, true) : null, '重新读取并收起');
  } finally { collapsing = false; button.disabled = false; }
}
byId('collapse-floating').addEventListener('click', () => collapseFloating());
async function markJob(context) {
  if (operation) return;
  operation = true; pendingMark = context; render();
  try {
    const result = await message({ type: 'MARK_JOB_COMPANY', ...context });
    manualResult = { ...context, history: result.history };
    if (page?.visitId === context.visitId && page.current?.key === context.key && tabId === context.tabId) page.history = result.history;
    await loadRecords();
    if (!dataError && page?.visitId === context.visitId && tabId === context.tabId) feedback(result.history.state === 'manual' ? '已记录本次查看。' : '这家公司已有记录，首次日期保持不变。');
  } catch (error) { feedback(`保存失败：${error.message}`, true, () => markJob(context)); }
  finally { pendingMark = null; operation = false; render(); refreshPage(); }
}
async function remove(record) {
  if (operation) return;
  operation = true; render();
  try {
    await message({ type: 'REMOVE_COMPANY', key: record.key });
    if (manualResult?.key === record.key) manualResult = null;
    if (page?.current?.key === record.key) page.history = { state: 'suppressed', visitId: page.visitId };
    await loadRecords();
    if (!dataError) feedback(`已撤销 ${record.name} 的看过记录。`);
  } catch (error) { feedback(`撤销失败：${error.message}`, true, () => remove(record)); }
  finally { operation = false; render(); refreshPage(); }
}
async function updateContacted(record, contacted) {
  if (operation) return;
  operation = true; render();
  try {
    await message(contacted ? { type: 'MARK_CONTACTED', key: record.key, name: record.name, url: record.url } : { type: 'CANCEL_CONTACTED', key: record.key });
    await loadRecords();
    if (!dataError) feedback(contacted ? `已记录 ${record.name} 的沟通。` : `已取消 ${record.name} 的沟通标记，已查看记录保留。`);
  } catch (error) { feedback(`${contacted ? '标记' : '取消'}沟通失败：${error.message}`, true, () => updateContacted(record, contacted)); }
  finally { operation = false; render(); }
}
byId('search').addEventListener('input', () => { recordsExpanded = false; renderRecords(); });
byId('records-toggle').addEventListener('click', () => { recordsExpanded = !recordsExpanded; renderRecords(); });
byId('retry').addEventListener('click', () => { if (retryAction) retryAction(); });
byId('export').addEventListener('click', async () => {
  if (operation) return;
  operation = true; renderRecords();
  try {
    const latest = await message({ type: 'RECORDS' });
    const blob = new Blob([api.exportCsv(latest.records)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = `公司看过记录-${api.localDate(new Date().toISOString())}.csv`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    feedback('已生成全部公司记录的 CSV 文件。');
  } catch (error) { feedback(`导出失败：${error.message}`, true, loadRecords); }
  finally { operation = false; renderRecords(); }
});
chrome.tabs.onActivated.addListener(info => { if (info.windowId === panelWindowId) refreshPage(true); });
chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && (change.url || change.status)) refreshPage(true); });
chrome.tabs.onRemoved.addListener(id => { if (id === tabId) refreshPage(true); });
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'PAGE_CHANGED' && sender.id === chrome.runtime.id && sender.tab?.id === tabId) refreshPage(true);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[api.PAD_COLLAPSE_KEY]) {
    collapseOnCopyEnabled = changes[api.PAD_COLLAPSE_KEY].newValue === true;
    collapseOnCopy.checked = collapseOnCopyEnabled;
    collapseOnCopyStatus.textContent = '';
  }
  if (changes[api.LIST_CLICK_VIEW_KEY]) {
    listClickViewEnabled = api.listClickViewEnabled(changes[api.LIST_CLICK_VIEW_KEY].newValue);
    listClickView.checked = listClickViewEnabled;
    listClickViewStatus.textContent = '';
    renderPage();
  }
  if (Object.keys(changes).some(key => key.startsWith(api.PREFIX))) loadRecords();
});
setInterval(() => refreshPage(), 1500);
await Promise.all([loadRecords(), refreshPage(true)]);
