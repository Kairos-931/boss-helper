(() => {
  'use strict';
  const api = globalThis.BossTracker;
  function captureView(capture, now = Date.now()) {
    if (!capture?.running) return null;
    const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
    const total = Number.isInteger(capture.total) && capture.total >= 0 ? capture.total : null;
    const sessionCount = Number.isInteger(capture.sessionCount) && capture.sessionCount >= 0 ? capture.sessionCount : null;
    const totalError = typeof capture.totalError === 'string' ? capture.totalError.slice(0, 160) : '';
    const note = typeof capture.note === 'string' ? capture.note.slice(0, 160) : '';
    const error = typeof capture.error === 'string' ? capture.error.slice(0, 160) : '';
    const lastAt = Number.isFinite(capture.lastAt) ? capture.lastAt : 0;
    const success = !error && /^(已采集|已更新)：/.test(note);
    const fresh = lastAt && now - lastAt >= 0 && now - lastAt < (success ? 5000 : 8000);
    const recent = fresh ? error || note : '';
    return {
      mode: 'capture',
      name: '岗位采集',
      label: totalError ? '采集统计读取失败' : '本页采集中',
      total,
      totalText: total === null ? '—' : String(total),
      sessionCount,
      countText: sessionCount === null ? '—' : String(sessionCount),
      added: count(capture.added),
      updated: count(capture.updated),
      failed: count(capture.failed),
      totalError,
      recent,
      recentError: !!error && fresh,
      red: false,
      green: false,
      canView: false,
      canUndo: false,
      canContact: false,
      unavailable: !!totalError,
      seenAt: '',
      quiet: true
    };
  }
  function floatingView(page, record, recentVisit = null) {
    const reliable = page?.kind === 'detail' && !!api.validCompany(page.current)
      && (page.detailType === 'company' ? page.source === 'company-page' : ['job-card-match', 'job-company-link'].includes(page.source));
    if (!reliable) return { name: page?.nameHint || 'BOSS 助手', label: page?.kind === 'list' ? '展开职位查看公司' : page?.nameHint ? '仅识别简称，请在侧栏核对' : '无法识别当前公司', red: false, green: false, canView: false, canUndo: false, canContact: false, seenAt: '', quiet: false };
    const suppressed = page.detailType === 'company' && page.history?.state === 'suppressed';
    const fresh = ['first', 'manual'].includes(page.history?.state) || (page.detailType === 'job' && api.isFreshView(record, recentVisit));
    const contacted = !!record?.contactedAt;
    const waiting = page.detailType === 'company' && !page.history;
    const canView = page.detailType === 'job' && !record;
    const green = !suppressed && !waiting && !!record && fresh;
    const canUndo = green && !contacted && ['first', 'manual'].includes(page.history?.state);
    return {
      name: page.current.name,
      label: suppressed ? '本次已撤销' : contacted ? green ? '本次已沟通' : '已沟通' : record ? fresh ? '本次已记录' : waiting ? '正在确认本次查看' : '之前看过' : page.history?.state === 'error' ? '暂未自动记录，请打开侧栏' : '未记录',
      red: !suppressed && !!record && !fresh && !waiting,
      green,
      canView,
      canUndo,
      canContact: !suppressed && !contacted && !waiting,
      seenAt: record && !waiting ? api.localDateTime(record.markedAt) : '',
      quiet: api.isRecentlyAdded(record)
    };
  }
  function createFloatingService(chrome, repository, visits, capture = null) {
    const POSITION_KEY = 'floating-position';
    function validPosition(value) {
      return value && Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.y >= 0 && value.x <= 100000 && value.y <= 100000;
    }
    function retryable(message = '页面正在更新，稍后自动重试。') {
      return Object.assign(new Error(message), { code: 'FLOAT_STATUS_RETRY' });
    }
    async function current(message, sender) {
      const tab = await chrome.tabs.get(sender.tab.id);
      if (!tab.active || tab.status === 'loading' || message.href !== tab.url) throw new Error('页面已切换，请在当前公司重新操作。');
      const raw = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE' }, { frameId: 0 });
      const page = api.validateSnapshot(raw, tab.url);
      if (!page || page.token !== message.token || page.visitId !== message.visitId || page.current?.key !== message.key || (raw.documentId && raw.documentId !== sender.documentId)) throw new Error('公司信息已变化，请稍候重试。');
      const latest = await chrome.tabs.get(tab.id);
      if (!latest.active || latest.status === 'loading' || latest.url !== tab.url) throw new Error('页面已切换，请稍候重试。');
      return page;
    }
    async function read(message, sender) {
      const tab = await chrome.tabs.get(sender.tab.id);
      if (!tab.active) throw retryable('页面不在前台，稍后自动重试。');
      const raw = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE' }, { frameId: 0 });
      const page = api.validateSnapshot(raw, tab.url);
      if (!page) throw retryable();
      if (raw.documentId && sender.documentId && raw.documentId !== sender.documentId) throw retryable();
      if (page.visitId !== message.visitId || page.current?.key !== message.key) throw retryable();
      const latest = await chrome.tabs.get(tab.id);
      if (latest.url !== tab.url) throw retryable();
      return page;
    }
    async function status(message, sender) {
      const page = await read(message, sender);
      const preferences = await chrome.storage.local.get('sound-enabled');
      const window = await chrome.windows.get(sender.tab.windowId);
      const captureState = capture?.summary ? await capture.summary(sender.tab.id) : null;
      if (captureState?.running) return { view: captureView(captureState), soundEnabled: preferences['sound-enabled'] !== false, soundAllowed: false };
      const record = page.current ? (await repository.list()).find(value => value.key === page.current.key) : null;
      const visitKey = api.VISIT_PREFIX + sender.tab.id;
      const recentVisit = page.detailType === 'job' ? (await chrome.storage.session.get(visitKey))[visitKey] || null : null;
      return { view: floatingView(page, record, recentVisit), soundEnabled: preferences['sound-enabled'] !== false, soundAllowed: !!window.focused };
    }
    async function setSound(message, sender) {
      if (typeof message.enabled !== 'boolean') throw new Error('提示音设置无效，请重试。');
      await current(message, sender);
      await chrome.storage.local.set({ 'sound-enabled': message.enabled });
      return { soundEnabled: message.enabled };
    }
    async function position() {
      const value = (await chrome.storage.local.get(POSITION_KEY))[POSITION_KEY];
      return { position: validPosition(value) ? { x: value.x, y: value.y } : null };
    }
    async function setPosition(message) {
      if (!validPosition(message)) throw new Error('悬浮球位置无效，未保存。');
      const value = { x: Math.round(message.x), y: Math.round(message.y) };
      await chrome.storage.local.set({ [POSITION_KEY]: value });
      return { position: value };
    }
    function mark(message, sender) {
      return visits.recover(async () => {
        async function verify() {
          const page = await current(message, sender);
          const window = await chrome.windows.get(sender.tab.windowId);
          const saved = (await chrome.storage.session.get(api.VISIT_PREFIX + sender.tab.id))[api.VISIT_PREFIX + sender.tab.id];
          if (!window.focused || !floatingView(page, null).canContact || (page.detailType === 'company' && saved?.visitId === page.visitId && saved.state === 'suppressed')) throw new Error('当前公司无法标记，请重新确认页面。');
          return page;
        }
        const page = await verify();
        return { record: await repository.markContacted(page.current, 'manual', verify) };
      });
    }
    function view(message, sender) {
      async function verify() {
        const page = await current(message, sender);
        const window = await chrome.windows.get(sender.tab.windowId);
        if (!window.focused || page.kind !== 'detail' || page.detailType !== 'job' || !['job-card-match', 'job-company-link'].includes(page.source)) throw new Error('当前职位无法标记，请重新确认页面。');
        return { ...page, documentId: sender.documentId || '' };
      }
      return (async () => {
        const page = await verify();
        const history = await visits.manual(sender.tab.id, page, verify);
        await chrome.tabs.sendMessage(sender.tab.id, { type: 'VISIT_RESULT', history }).catch(() => {});
        return { history };
      })();
    }
    function undo(message, sender) {
      async function verify() {
        const page = await current(message, sender);
        const window = await chrome.windows.get(sender.tab.windowId);
        if (!window.focused) throw new Error('当前页面不在前台，未撤销。');
        const record = page.current ? (await repository.list()).find(value => value.key === page.current.key) : null;
        const visitKey = api.VISIT_PREFIX + sender.tab.id;
        const recentVisit = page.detailType === 'job' ? (await chrome.storage.session.get(visitKey))[visitKey] || null : null;
        if (!floatingView(page, record, recentVisit).canUndo) throw new Error('当前记录无法撤销，请重新确认页面。');
        return page;
      }
      return (async () => {
        const page = await verify();
        const affected = await visits.remove(page.current.key);
        await Promise.allSettled(affected.map(({ tabId, history }) => chrome.tabs.sendMessage(tabId, { type: 'VISIT_RESULT', history })));
        return { removed: true };
      })();
    }
    return { status, mark, view, undo, position, setPosition, setSound };
  }
  Object.assign(api, { captureView, floatingView, createFloatingService });
})();
