(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const JOB_ENDPOINT = 'https://www.zhipin.com/wapi/zpgeek/job/detail.json';
  const REQUEST_TTL = 30000;
  const RESULT_TTL = 60000;
  const API_FAILURE = '未取得可确认的接口薪资，请在采集开启时重新打开该岗位；遇到验证请先在BOSS完成验证。';
  function isJobEndpoint(href) {
    try {
      const url = new URL(href);
      return !url.username && !url.password && !url.hash && url.origin + url.pathname === JOB_ENDPOINT;
    } catch { return false; }
  }
  function parseJobSalaryResponse(body) {
    const info = body?.code === 0 && body.zpData?.jobInfo;
    if (!info || typeof info.encryptId !== 'string' || !/^[A-Za-z0-9_~\-]{1,128}$/.test(info.encryptId)) return null;
    const salary = api.readableSalary(info.salaryDesc);
    return salary ? { key: 'job:' + info.encryptId, salary } : null;
  }
  function createJobApi(chrome, { session, changed }, transport = (...args) => fetch(...args), clock = () => Date.now()) {
    const requests = new Map(), latest = new Map(), results = new Map(), seen = new Set();
    async function authorize(entry, requireReader = true) {
      const value = await session(entry.tabId);
      const tab = await chrome.tabs.get(entry.tabId);
      const window = await chrome.windows.get(tab.windowId);
      if (!value?.running || (entry.sessionId && value.id !== entry.sessionId) || (value.startedAt && entry.at < value.startedAt)
        || !tab.active || !window.focused || (requireReader && tab.status === 'loading') || !api.isBossPage(tab.url) || (entry.href && tab.url !== entry.href)
        || latest.get(entry.tabId) !== entry || clock() - entry.at > REQUEST_TTL) return null;
      if (requireReader) {
        let snapshot;
        try { snapshot = await chrome.tabs.sendMessage(entry.tabId, { type: 'GET_JOB', sessionId: value.id }, { frameId: 0, documentId: entry.documentId }); } catch { return null; }
        if (snapshot?.documentId !== entry.documentId || snapshot.href !== tab.url || latest.get(entry.tabId) !== entry) return null;
      }
      return { sessionId: value.id, href: tab.url };
    }
    function finish(entry) {
      entry.done = true;
      if (requests.get(entry.id) === entry) requests.delete(entry.id);
      clearTimeout(entry.expiry);
      // Never persist the credential-bearing URL or keep it after this request.
      delete entry.url;
    }
    function cancel(tabId) {
      latest.delete(tabId); results.delete(tabId);
      for (const entry of requests.values()) if (entry.tabId === tabId) { entry.controller?.abort(); finish(entry); }
    }
    function before(details) {
      if (details.tabId < 0 || !Number.isInteger(details.tabId) || details.frameId !== 0 || details.type !== 'xmlhttprequest'
        || details.method !== 'GET' || details.initiator !== 'https://www.zhipin.com' || typeof details.documentId !== 'string' || !details.documentId
        || typeof details.requestId !== 'string' || !isJobEndpoint(details.url)) return;
      if (seen.has(details.requestId)) return;
      seen.add(details.requestId);
      if (seen.size > 256) seen.delete(seen.values().next().value);
      const at = Number.isFinite(details.timeStamp) ? details.timeStamp : clock();
      if (at > clock() + 1000 || clock() - at > REQUEST_TTL || (latest.get(details.tabId)?.at ?? -Infinity) > at) return;
      for (const entry of requests.values()) if (clock() - entry.at > REQUEST_TTL) { entry.controller?.abort(); finish(entry); }
      cancel(details.tabId);
      if (requests.size >= 40) return;
      const entry = { id: details.requestId, tabId: details.tabId, documentId: details.documentId, url: details.url, at };
      latest.set(entry.tabId, entry); requests.set(details.requestId, entry);
      entry.expiry = setTimeout(() => {
        entry.controller?.abort(); finish(entry);
        if (latest.get(entry.tabId) === entry) {
          latest.delete(entry.tabId);
          if (entry.sessionId) changed(entry.tabId, entry.sessionId).catch(() => {});
        }
      }, REQUEST_TTL);
      entry.expiry.unref?.();
      // A navigation can issue its detail request before document_idle installs the reader.
      // Retain only this observed request briefly; fetching still requires that reader's document.
      entry.context = authorize(entry, false).then(context => {
        if (!context || entry.done) { finish(entry); return null; }
        Object.assign(entry, context);
        return context;
      }).catch(() => { finish(entry); return null; });
    }
    async function completed(details) {
      const entry = requests.get(details.requestId);
      if (!entry || entry.claimed) return;
      entry.claimed = true;
      entry.completedOk = details.tabId === entry.tabId && details.frameId === 0 && details.documentId === entry.documentId && details.url === entry.url && details.statusCode === 200;
      return process(entry);
    }
    async function process(entry) {
      if (entry.processing || entry.done || !entry.claimed) return;
      entry.processing = true;
      let accepted = false;
      try {
        if (!await entry.context || entry.done) { finish(entry); return; }
        if (!await authorize(entry)) {
          if (latest.get(entry.tabId) !== entry || clock() - entry.at > REQUEST_TTL) finish(entry);
          return;
        }
        accepted = true;
        if (!entry.completedOk) throw new Error(API_FAILURE);
        entry.controller = new AbortController();
        const timer = setTimeout(() => entry.controller.abort(), 8000);
        let body;
        try {
          const response = await transport(entry.url, { method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' }, signal: entry.controller.signal });
          if (!response.ok || !isJobEndpoint(response.url) || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error(API_FAILURE);
          const text = await response.text();
          if (text.length > 2000000) throw new Error(API_FAILURE);
          body = parseJobSalaryResponse(JSON.parse(text));
          if (!body) throw new Error(API_FAILURE);
        } finally { clearTimeout(timer); }
        if (!await authorize(entry)) return;
        results.set(entry.tabId, { sessionId: entry.sessionId, documentId: entry.documentId, href: entry.href, at: clock(), ...body });
        await changed(entry.tabId, entry.sessionId);
      } catch {
        if (await authorize(entry).catch(() => null)) {
          results.set(entry.tabId, { sessionId: entry.sessionId, documentId: entry.documentId, href: entry.href, at: clock(), error: API_FAILURE });
          await changed(entry.tabId, entry.sessionId).catch(() => {});
        }
      } finally {
        entry.processing = false;
        if (accepted) finish(entry);
      }
    }
    function failed(details) {
      const entry = requests.get(details.requestId);
      if (entry) completed({ ...details, tabId: entry.tabId, frameId: 0, documentId: entry.documentId, url: entry.url, statusCode: 0 }).catch(() => {});
    }
    function read(tabId, sessionId, documentId, href, key) {
      const matches = entry => entry?.sessionId === sessionId && entry.documentId === documentId && entry.href === href;
      const result = results.get(tabId);
      if (matches(result) && clock() - result.at <= RESULT_TTL) {
        if (result.error) return { error: result.error };
        return result.key === key ? { salary: result.salary } : { waiting: '接口岗位与当前页面尚未对应，等待当前岗位详情。' };
      }
      const entry = latest.get(tabId);
      if (!matches(entry) || entry.done || clock() - entry.at > REQUEST_TTL) return null;
      if (entry.claimed && !entry.processing) process(entry).catch(() => {});
      return { waiting: '正在读取当前岗位的接口薪资…' };
    }
    const filter = { urls: [JOB_ENDPOINT + '*'], types: ['xmlhttprequest'] };
    chrome.webRequest?.onBeforeRequest.addListener(before, filter);
    chrome.webRequest?.onCompleted.addListener(details => { completed(details).catch(() => {}); }, filter);
    chrome.webRequest?.onErrorOccurred.addListener(failed, filter);
    return { read, cancel, before, completed };
  }
  Object.assign(api, { JOB_ENDPOINT, isJobEndpoint, parseJobSalaryResponse, createJobApi });
})();
