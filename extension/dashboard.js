import './core/identity.js';
import './core/rest.js';
import './core/records.js';
import './core/jobs.js';
const api = globalThis.BossTracker;
const el = id => document.getElementById(id);
let records = [], ticket = 0;
function node(tag, text, cls) { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; }
function label(record) { return record.rest ? api.restLabel(record.rest) : '未识别'; }
function bucket(timestamp) {
  const day = api.localDate(timestamp);
  if (el('period').value !== 'week') return day;
  const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
function draw() {
  const total = records.length, contacts = records.filter(r => r.contactedAt).length;
  el('total').textContent = total; el('contacted').textContent = contacts; el('uncontacted').textContent = total - contacts;
  el('rate').textContent = total ? `${Math.round(contacts / total * 100)}%` : '—';
  const days = new Map(), rests = new Map();
  for (const r of records) {
    const day = bucket(r.markedAt), item = days.get(day) || { added: 0, contacted: 0 }; item.added++; days.set(day, item);
    if (r.contactedAt) { const date = bucket(r.contactedAt), entry = days.get(date) || { added: 0, contacted: 0 }; entry.contacted++; days.set(date, entry); }
    const rest = label(r); rests.set(rest, (rests.get(rest) || 0) + 1);
  }
  const trend = el('trend'); trend.replaceChildren();
  let accumulated = 0;
  const entries = [...days].sort((a,b) => a[0].localeCompare(b[0])).map(([date, value]) => { accumulated += value.added; return [date, value, accumulated]; }).reverse().slice(0, 14);
  if (entries.length) {
    const points = [...entries].reverse(), max = Math.max(1, ...points.map(p => p[2]));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 400 90'); svg.setAttribute('class', 'trend-chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `累计记录趋势，当前${total}家公司`);
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', points.map((p, i) => `${points.length === 1 ? 200 : 8 + 384 * i / (points.length - 1)},${80 - 68 * p[2] / max}`).join(' '));
    polyline.setAttribute('fill', 'none'); polyline.setAttribute('stroke', '#216854'); polyline.setAttribute('stroke-width', '3'); svg.append(polyline); trend.append(svg);
  }
  for (const [date, value, cumulative] of entries) {
    const row = node('div', '', 'trend-row'); row.append(node('span', date), node('span', `新增 ${value.added} · 累计 ${cumulative} 家`), node('span', `沟通 ${value.contacted} 家`)); trend.append(row);
  }
  if (!days.size) trend.append(node('p', '暂无记录，浏览公司后这里会显示变化。', 'note'));
  const chart = el('rest'); chart.replaceChildren();
  for (const [name, count] of [...rests].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))) {
    const row = node('div', '', 'stat-row'), bar = node('div', '', 'bar'), fill = node('i', ''); fill.style.width = `${count / total * 100}%`; bar.append(fill); row.append(node('span', name), bar, node('span', `${count} 家`)); chart.append(row);
  }
  if (!rests.size) chart.append(node('p', '暂无休息制度数据。', 'note'));
  const select = el('rest-filter'), previous = select.value; select.replaceChildren();
  const all = node('option', '全部'); all.value = 'all'; select.append(all);
  for (const name of [...rests.keys()].sort((a,b) => a.localeCompare(b, 'zh-CN'))) { const option = node('option', name); option.value = name; select.append(option); }
  const selected = [...select.options].find(o => o.value === previous) || all; selected.selected = true;
  drawRows();
}
function drawRows() {
  const query = el('search').value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'), contact = el('contact-filter').value || 'all', rest = el('rest-filter').value || 'all';
  const matches = records.filter(r => r.name.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(query) && (contact === 'all' || (contact === 'yes') === !!r.contactedAt) && (rest === 'all' || label(r) === rest));
  el('count').textContent = `· ${matches.length} 家`; const rows = el('rows'); rows.replaceChildren();
  for (const r of matches) {
    const row = document.createElement('tr'), first = document.createElement('td'), link = node('a', r.name); link.href = r.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; first.append(link); row.append(first, node('td', api.localDate(r.markedAt)));
    const state = document.createElement('td'); state.append(node('span', r.contactedAt ? '已沟通' : '未标记沟通', 'tag')); row.append(state, node('td', r.contactedAt ? api.localDate(r.contactedAt) : '—'), node('td', label(r))); rows.append(row);
  }
  el('empty').hidden = !!matches.length; el('empty').textContent = records.length ? '没有符合条件的公司。' : '还没有公司记录。';
}
async function load() {
  const current = ++ticket;
  const [recordResult, jobResult] = await Promise.allSettled([
    chrome.runtime.sendMessage({ type: 'RECORDS' }),
    chrome.runtime.sendMessage({ type: 'JOBS_SUMMARY' })
  ]);
  if (current !== ticket) return;
  const companyData = recordResult.status === 'fulfilled' ? recordResult.value : null;
  const companiesOk = companyData?.ok && Array.isArray(companyData.records);
  if (companiesOk) {
    records = companyData.records; el('error').hidden = true; draw();
  } else {
    records = []; draw(); el('sync').textContent = '读取失败'; el('error').hidden = false; el('error').textContent = '暂时无法读取公司记录，请重新打开看板或重载扩展后重试。';
    for (const id of ['total','contacted','uncontacted','rate']) el(id).textContent = '—';
    el('empty').hidden = true;
  }
  const jobs = jobResult.status === 'fulfilled' ? jobResult.value : null;
  const jobsOk = jobs?.ok && Number.isInteger(jobs.total) && jobs.total >= 0;
  el('jobs-total').textContent = jobsOk ? String(jobs.total) : '—';
  el('jobs-total-note').textContent = jobsOk ? '当前保留的岗位' : '统计读取失败，重开看板';
  if (companiesOk) el('sync').textContent = jobsOk ? '数据已更新 · 仅本机' : '公司数据已更新 · 岗位统计读取失败';
}
for (const id of ['search','contact-filter','rest-filter']) el(id).addEventListener(id === 'search' ? 'input' : 'change', drawRows);
el('period').addEventListener('change', draw);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(key => key.startsWith(api.PREFIX) || key.startsWith(api.JOB_PREFIX))) load();
});
await load();
