(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const JOB_PREFIX = 'job:';
  const CAPTURE_PREFIX = 'job-capture:';
  function readableSalary(value) {
    if (typeof value !== 'string' || value.length > 200) return null;
    const text = value.trim();
    if (/^(?:薪资|待遇)?面议$/.test(text)) return text;
    const amount = '\\d+(?:\\.\\d+)?\\s*(?:[kKwWＫｋＷｗ]|千|万元?|元)?';
    const format = new RegExp(`^(?:月薪|年薪|日薪|时薪)?\\s*${amount}(?:\\s*[-~～—–至]\\s*${amount})?(?:\\s*[/／]\\s*(?:月|年|天|日|小时|时|周|次))?(?:\\s*[·•・×x*]\\s*\\d{1,2}(?:\\.\\d)?薪)?$`);
    return /[kKwWＫｋＷｗ千万元]/.test(text) && format.test(text) ? text : null;
  }
  function validJob(value) {
    if (!value || typeof value.key !== 'string' || !value.key.startsWith(JOB_PREFIX) || !api.jobIdentity(value.url) || api.jobIdentity(value.url) !== value.key) return null;
    const url = new URL(value.url);
    if (url.search || url.hash) return null;
    const result = { key: value.key, url: url.origin + url.pathname };
    for (const [key, limit] of Object.entries({ name: 300, salary: 200, city: 200, experience: 200, education: 200, description: 60000, companyName: 180 })) {
      if (typeof value[key] !== 'string' || value[key].length > limit) return null;
      result[key] = value[key].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    }
    if (!result.name || !result.description || value.source !== 'visible-page') return null;
    result.company = api.validCompany(value.company);
    result.companyName = result.company?.name || result.companyName;
    result.source = 'visible-page';
    result.salarySource = value.salarySource === 'detail-api' ? 'detail-api' : 'visible-page';
    return result;
  }
  function validJobRecord(value) {
    const job = validJob(value);
    if (!job || typeof value.firstCollectedAt !== 'string' || typeof value.lastCollectedAt !== 'string' || !Number.isFinite(Date.parse(value.firstCollectedAt)) || !Number.isFinite(Date.parse(value.lastCollectedAt)) || Date.parse(value.lastCollectedAt) < Date.parse(value.firstCollectedAt)) return null;
    return { ...job, firstCollectedAt: value.firstCollectedAt, lastCollectedAt: value.lastCollectedAt };
  }
  function createJobRepository(storage, clock = () => new Date()) {
    let queue = Promise.resolve();
    async function list() {
      const values = await storage.get(null);
      return Object.entries(values).filter(([key]) => key.startsWith(JOB_PREFIX)).map(([key, value]) => {
        const record = validJobRecord(value);
        if (!record || record.key !== key) throw new Error('岗位资料格式异常，原资料已保留；请联系开发核对。');
        return record;
      }).sort((a, b) => b.lastCollectedAt.localeCompare(a.lastCollectedAt) || a.key.localeCompare(b.key));
    }
    function save(value, verify) {
      const operation = queue.then(async () => {
        const job = validJob(value);
        if (!job) throw new Error('岗位资料或链接不完整，未保存。');
        if (!readableSalary(job.salary)) throw new Error('薪资尚未可靠识别，请在采集开启时重新打开该岗位。');
        const original = (await storage.get(job.key))[job.key];
        const previous = original === undefined ? null : validJobRecord(original);
        if (original !== undefined && (!previous || previous.key !== job.key)) throw new Error('原岗位资料异常，未覆盖；请联系开发核对。');
        const at = clock().toISOString();
        const record = { ...job, firstCollectedAt: previous?.firstCollectedAt || at, lastCollectedAt: at };
        if (!validJobRecord(record)) throw new Error('采集时间异常，未覆盖原岗位资料。');
        await verify();
        await storage.set({ [job.key]: record });
        return { record, added: !previous };
      });
      queue = operation.catch(() => {});
      return operation;
    }
    return { list, save };
  }
  function exportJobsCsv(jobs, companies) {
    const rows = [['岗位标识', '职位名称', '公司名称', '岗位链接', '薪资原文', '城市', '经验', '学历', '岗位描述', '首次采集时间（上海）', '最近采集时间（上海）', '公司链接', '公司已查看', '公司已沟通', '薪资来源']];
    const index = new Map(companies.map(company => [company.key, company]));
    for (const job of jobs) {
      const company = job.company ? index.get(job.company.key) : null;
      rows.push([job.key, job.name, job.companyName, job.url, readableSalary(job.salary) || '待重新采集', job.city, job.experience, job.education, job.description,
        api.localDateTime(job.firstCollectedAt), api.localDateTime(job.lastCollectedAt), job.company?.url || '', job.company ? company ? '是' : '未记录' : '未知', job.company ? company?.contactedAt ? '是' : '未标记' : '未知', readableSalary(job.salary) ? job.salarySource === 'detail-api' ? 'BOSS职位详情接口' : '页面可读文本' : '待重新采集']);
    }
    return '\uFEFF' + rows.map(row => row.map(api.csvCell).join(',')).join('\r\n') + '\r\n';
  }
  function createCaptureService(chrome, jobs, companies) {
    let queue = Promise.resolve();
    const serial = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
    const keyFor = id => CAPTURE_PREFIX + id;
    async function session(id) { return (await chrome.storage.session.get(keyFor(id)))[keyFor(id)] || null; }
    const salaryApi = api.createJobApi?.(chrome, { session, changed: (tabId, sessionId) => serial(async () => {
      const value = await session(tabId);
      if (!value?.running || value.id !== sessionId) return;
      await chrome.storage.session.set({ [keyFor(tabId)]: { ...value, lastToken: '', error: '' } });
      await chrome.tabs.sendMessage(tabId, { type: 'JOBS_ACTIVATE', sessionId }, { frameId: 0 }).catch(() => {});
    }) });
    async function panelTab(message, required = true) {
      if (!Number.isInteger(message.windowId)) throw new Error('无法确认当前窗口，请重新打开侧栏。');
      const tab = (await chrome.tabs.query({ active: true, windowId: message.windowId }))[0];
      if (required) {
        const window = await chrome.windows.get(message.windowId);
        if (!tab || !window.focused || !tab.active || tab.windowId !== message.windowId || !api.isBossPage(tab.url) || tab.status === 'loading' || (message.tabId !== undefined && message.tabId !== tab.id)) throw new Error('请在当前BOSS标签页重试采集。');
      }
      return tab;
    }
    async function status(message) {
      const tab = await panelTab(message, false);
      const sessions = await chrome.storage.session.get(null);
      const others = Object.entries(sessions).filter(([key, value]) => key.startsWith(CAPTURE_PREFIX) && value?.running && key !== keyFor(tab?.id)).length;
      const records = await jobs.list();
      const value = tab ? await session(tab.id) : null;
      let sessionView = null;
      if (value) {
        const { keys, ...rest } = value;
        const keySet = new Set(Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key.startsWith(JOB_PREFIX)) : []);
        const sessionCount = records.filter(job => keySet.has(job.key)).length;
        sessionView = { ...rest, sessionCount };
      }
      return { tabId: tab?.id ?? null, canStart: !!tab?.active && api.isBossPage(tab?.url) && tab.status !== 'loading', session: sessionView, total: records.length, salaryPending: records.filter(job => !readableSalary(job.salary)).length, others };
    }
    async function start(message) {
      const tab = await panelTab(message);
      const old = await session(tab.id);
      if (!old?.running) salaryApi?.cancel(tab.id);
      const value = old?.running ? { ...old, keys: Array.isArray(old.keys) ? old.keys : [], lastToken: '', error: '', note: '正在重新读取当前岗位…', lastAt: Date.now() }
        : { running: true, id: crypto.randomUUID(), startedAt: Date.now(), added: 0, updated: 0, failed: 0, lastToken: '', lastName: '', error: '', note: '请重新打开具体岗位，取得详情与可读薪资后自动采集。', lastAt: Date.now(), keys: [] };
      await chrome.storage.session.set({ [keyFor(tab.id)]: value });
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'JOBS_ACTIVATE', sessionId: value.id }, { frameId: 0 });
        if (!result?.ready) throw new Error('读取器尚未连接。');
      } catch {
        await chrome.storage.session.set({ [keyFor(tab.id)]: { ...value, running: false, error: '页面读取未连接，请先点击上方“重新读取”，再开始采集。', lastAt: Date.now() } });
        throw new Error('请先点击上方“重新读取”，再开始采集。');
      }
      return status(message);
    }
    async function pause(message) {
      const tab = await panelTab(message, false);
      const tabId = message.tabId ?? tab?.id;
      if (!Number.isInteger(tabId)) throw new Error('无法确认采集标签页，请重试。');
      const target = await chrome.tabs.get(tabId);
      if (target.windowId !== message.windowId) throw new Error('采集标签页不在当前窗口。');
      const value = await session(tabId);
      salaryApi?.cancel(tabId);
      if (value) await chrome.storage.session.set({ [keyFor(tabId)]: { ...value, running: false, note: '已暂停，已采集资料保留。', lastAt: Date.now() } });
      await chrome.tabs.sendMessage(tabId, { type: 'JOBS_DEACTIVATE', sessionId: value?.id }, { frameId: 0 }).catch(() => {});
      return status(message);
    }
    async function context(sender) {
      const value = await session(sender.tab.id);
      return { sessionId: value?.running ? value.id : null };
    }
    async function signal(message, sender) {
      const tabId = sender.tab.id;
      const value = await session(tabId);
      if (!value?.running || value.id !== message.sessionId) return { captured: false, inactive: true };
      if (typeof message.token !== 'string' || message.token.length > 180) throw new Error('岗位读取状态异常，请暂停后重试。');
      if (value.lastToken === message.token && !value.error) return { captured: false, duplicate: true };
      let raw;
      async function verify() {
        const current = await session(tabId);
        const tab = await chrome.tabs.get(tabId);
        const window = await chrome.windows.get(tab.windowId);
        if (!current?.running || current.id !== value.id || !tab.active || !window.focused || tab.status === 'loading' || !api.isBossPage(tab.url) || tab.url !== message.href) throw new Error('页面已切换或不在前台，等待再次打开岗位。');
        const next = await chrome.tabs.sendMessage(tabId, { type: 'GET_JOB', sessionId: value.id }, { frameId: 0 });
        if (!next || next.href !== tab.url || next.token !== message.token || (sender.documentId && next.documentId !== sender.documentId)) throw new Error('岗位详情正在更新，暂未采集。');
        if (raw && JSON.stringify(next) !== JSON.stringify(raw)) throw new Error('岗位资料已变化，暂未保存旧内容。');
        const latest = await chrome.tabs.get(tabId);
        const focused = await chrome.windows.get(latest.windowId);
        if (!latest.active || !focused.focused || latest.url !== tab.url || latest.status === 'loading') throw new Error('页面已切换，暂未采集。');
        return next;
      }
      try {
        raw = await verify();
        if (raw.state !== 'ready') {
          await chrome.storage.session.set({ [keyFor(tabId)]: { ...value, lastToken: message.token, error: '', note: typeof raw.reason === 'string' ? raw.reason.slice(0, 160) : '请打开具体岗位。', lastAt: Date.now() } });
          return { captured: false, waiting: true };
        }
        const job = validJob(raw.job);
        if (!job) throw new Error('岗位资料或链接不完整，未保存。');
        const salary = salaryApi?.read(tabId, value.id, raw.documentId, raw.href, job.key);
        if (salary?.error) throw new Error(salary.error);
        if (salary?.waiting || (!salary?.salary && !readableSalary(job.salary))) {
          await chrome.storage.session.set({ [keyFor(tabId)]: { ...value, lastToken: message.token, error: '', note: salary?.waiting || '薪资为特殊字体或尚未取得，请在采集开启时重新打开这个岗位。', lastAt: Date.now() } });
          return { captured: false, waiting: true };
        }
        if (salary?.salary) job.salary = salary.salary;
        job.salarySource = salary?.salary ? 'detail-api' : 'visible-page';
        const result = await jobs.save(job, verify);
        const keys = Array.isArray(value.keys) ? value.keys.filter(key => typeof key === 'string' && key.startsWith(JOB_PREFIX)) : [];
        if (!keys.includes(job.key)) keys.push(job.key);
        await chrome.storage.session.set({ [keyFor(tabId)]: { ...value, keys, lastToken: message.token, added: value.added + Number(result.added), updated: value.updated + Number(!result.added), lastName: job.name, error: '', note: `${result.added ? '已采集' : '已更新'}：${job.name}`, lastAt: Date.now() } });
        return { captured: true, added: result.added };
      } catch (error) {
        await chrome.storage.session.set({ [keyFor(tabId)]: { ...value, lastToken: message.token, failed: value.failed + 1, error: error.message, note: '', lastAt: Date.now() } });
        return { captured: false, error: error.message };
      }
    }
    function handle(message, sender) {
      return serial(async () => {
        if (message.type === 'JOBS_CONTEXT') return context(sender);
        if (message.type === 'JOBS_SIGNAL') return signal(message, sender);
        if (message.type === 'JOBS_SUMMARY') return { total: (await jobs.list()).length };
        if (message.type === 'JOBS_STATUS') return status(message);
        if (message.type === 'JOBS_START') return start(message);
        if (message.type === 'JOBS_PAUSE') return pause(message);
        if (message.type === 'JOBS_EXPORT') {
          const scope = message.scope === 'session' ? 'session' : 'all';
          let records = await jobs.list();
          if (scope === 'session') {
            const tab = await panelTab(message, false);
            const tabId = message.tabId ?? tab?.id;
            if (!Number.isInteger(tabId)) throw new Error('无法确认本次采集标签页，请重新打开侧栏后重试。');
            if (tab && tab.id !== tabId) throw new Error('采集标签页已切换，请重新导出。');
            const value = await session(tabId);
            const keys = new Set(Array.isArray(value?.keys) ? value.keys.filter(key => typeof key === 'string' && key.startsWith(JOB_PREFIX)) : []);
            records = records.filter(job => keys.has(job.key));
          }
          return { csv: exportJobsCsv(records, await companies.list()), count: records.length, salaryPending: records.filter(job => !readableSalary(job.salary)).length, scope };
        }
        throw new Error('未知采集操作。');
      });
    }
    async function summary(tabId) {
      const value = await session(tabId);
      if (!value?.running) return null;
      let records = [], total = null, totalError = '';
      try { records = await jobs.list(); total = records.length; }
      catch (error) { totalError = error?.message || '岗位统计读取失败，稍后自动重试。'; }
      const keySet = new Set(Array.isArray(value.keys) ? value.keys.filter(key => typeof key === 'string' && key.startsWith(JOB_PREFIX)) : []);
      const sessionCount = total === null ? null : records.filter(job => keySet.has(job.key)).length;
      return {
        running: true,
        total,
        sessionCount,
        totalError,
        added: Number.isInteger(value.added) ? value.added : 0,
        updated: Number.isInteger(value.updated) ? value.updated : 0,
        failed: Number.isInteger(value.failed) ? value.failed : 0,
        lastName: typeof value.lastName === 'string' ? value.lastName.slice(0, 300) : '',
        note: typeof value.note === 'string' ? value.note.slice(0, 200) : '',
        error: typeof value.error === 'string' ? value.error.slice(0, 200) : '',
        lastAt: Number.isFinite(value.lastAt) ? value.lastAt : 0
      };
    }
    function close(tabId) { salaryApi?.cancel(tabId); return serial(() => chrome.storage.session.remove(keyFor(tabId))); }
    return { handle, summary, close, invalidateSource: tabId => salaryApi?.cancel(tabId) };
  }
  Object.assign(api, { JOB_PREFIX, CAPTURE_PREFIX, readableSalary, validJob, validJobRecord, createJobRepository, exportJobsCsv, createCaptureService });
})();
