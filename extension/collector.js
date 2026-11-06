import './core/identity.js';
import './core/rest.js';
import './core/records.js';
import './core/jobs.js';

async function mountCollector(document, chrome) {
  const api = globalThis.BossTracker;
  const el = id => document.getElementById(id);
  const windowId = (await chrome.windows.getCurrent()).id;
  const SUCCESS_MS = 5000, PROBLEM_MS = 8000;
  let current = null, busy = false, ticket = 0;
  async function send(message) {
    const result = await chrome.runtime.sendMessage({ windowId, ...message });
    if (!result?.ok) throw new Error(result?.error || '助手连接已中断，请重新打开侧栏。');
    return result;
  }
  function note(value, error = false) { el('jobs-note').textContent = value; el('jobs-note').className = `capture-note${error ? ' error' : ''}`; }
  function recent(session) {
    if (!session) return { text: '', error: false };
    const lastAt = Number.isFinite(session.lastAt) ? session.lastAt : 0;
    if (!lastAt) return { text: '', error: false };
    const success = !session.error && /^(已采集|已更新)：/.test(session.note || '');
    const age = Date.now() - lastAt;
    if (age < 0 || age >= (success ? SUCCESS_MS : PROBLEM_MS)) return { text: '', error: false };
    return { text: session.error || session.note || '', error: !!session.error };
  }
  function exportState() {
    const sessionCount = Number.isInteger(current?.session?.sessionCount) ? current.session.sessionCount : 0;
    el('jobs-export-session').textContent = sessionCount ? `导出本次（${sessionCount}）` : '导出本次';
    el('jobs-export').textContent = current?.total ? `导出全部（${current.total}）` : '导出全部';
    el('jobs-export-session').disabled = busy || !sessionCount;
    el('jobs-export').disabled = busy || !current?.total;
  }
  function render() {
    const running = current?.session?.running;
    el('jobs-state').textContent = running ? '本页采集中' : '未开启';
    el('jobs-toggle').textContent = running ? '暂停本页采集' : '开始采集本页';
    el('jobs-toggle').disabled = busy || !current || (!running && !current.canStart);
    el('jobs-retry').hidden = true;
    el('jobs-retry').disabled = busy;
    exportState();
    if (!current) return;
    const session = current.session;
    const message = recent(session);
    el('jobs-retry').hidden = !running || !message.error;
    el('jobs-count').textContent = `累计 ${current.total} 个岗位${session ? ` · 本次新增 ${session.added} · 更新 ${session.updated} · 未成功 ${session.failed}` : ''}`;
    const elsewhere = current.others ? `另有 ${current.others} 个标签页正在采集。` : '';
    const fallback = running ? '正在采集本页显示的岗位。' : current.canStart ? '开启后，只采集本页显示的岗位；导出后在 Excel 中筛选比较。' : '请切换到 BOSS 岗位页面再开始。';
    note([message.text || fallback, elsewhere].filter(Boolean).join(' '), message.error);
  }
  async function refresh() {
    const request = ++ticket;
    try {
      const result = await send({ type: 'JOBS_STATUS' });
      if (request !== ticket) return;
      current = result; el('jobs-refresh').hidden = true; render();
    } catch (error) {
      if (request !== ticket) return;
      current = null; render(); el('jobs-state').textContent = '读取失败'; el('jobs-count').textContent = '采集状态暂不可用'; el('jobs-refresh').hidden = false;
      note(`${error.message} 点击“重试读取”。`, true);
    }
  }
  async function action(type) {
    if (busy || !current) return;
    busy = true; ticket++; render();
    try {
      current = await send({ type, tabId: current.tabId }); render();
    } catch (error) { note(error.message, true); }
    finally { busy = false; el('jobs-toggle').disabled = !current || (!current.session?.running && !current.canStart); el('jobs-retry').disabled = false; exportState(); }
  }
  el('jobs-toggle').addEventListener('click', () => action(current?.session?.running ? 'JOBS_PAUSE' : 'JOBS_START'));
  el('jobs-retry').addEventListener('click', () => action('JOBS_START'));
  el('jobs-refresh').addEventListener('click', refresh);
  async function exportJobs(scope) {
    if (busy) return;
    busy = true; ticket++; render();
    try {
      const result = await send({ type: 'JOBS_EXPORT', scope, tabId: current?.tabId });
      if (!result.count) { note(scope === 'session' ? '本次还没有成功采集的岗位。' : '还没有岗位资料，请先开始采集。'); return; }
      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const label = scope === 'session' ? '本次' : '全部';
      const link = document.createElement('a'); link.href = url; link.download = `岗位资料-${label}-${api.localDateTime(new Date().toISOString()).replaceAll(':', '-').replace(' ', '-')}.csv`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      note(`已生成${label} ${result.count} 个岗位的 CSV 文件，可在 Excel 中打开。${result.salaryPending ? `${result.salaryPending} 个岗位的薪资已注明“待重新采集”。` : ''}`);
    } catch (error) { note(`导出失败：${error.message}，请再次点击导出。`, true); }
    finally { busy = false; el('jobs-toggle').disabled = !current || (!current.session?.running && !current.canStart); el('jobs-retry').disabled = false; exportState(); }
  }
  el('jobs-export-session').addEventListener('click', () => exportJobs('session'));
  el('jobs-export').addEventListener('click', () => exportJobs('all'));
  chrome.storage.onChanged.addListener((changes, area) => {
    const prefix = area === 'session' ? api.CAPTURE_PREFIX : area === 'local' ? api.JOB_PREFIX : null;
    if (prefix && Object.keys(changes).some(key => key.startsWith(prefix)) && !busy) refresh();
  });
  chrome.tabs.onActivated.addListener(info => { if (info.windowId === windowId && !busy) refresh(); });
  chrome.tabs.onUpdated.addListener((id, change) => { if (id === current?.tabId && (change.url || change.status) && !busy) refresh(); });
  setInterval(() => { if (!busy) refresh(); }, 1500);
  await refresh();
}
await mountCollector(document, chrome);
