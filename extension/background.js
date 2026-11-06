'use strict';
importScripts('core/identity.js', 'core/rest.js', 'core/settings.js', 'core/records.js', 'core/visits.js', 'core/pad.js', 'core/page-state.js', 'core/reconnect.js', 'core/floating.js', 'core/jobs.js', 'core/job-api.js');
const api = globalThis.BossTracker;
const repository = api.createRepository(chrome.storage.local);
const visits = api.createVisits(repository, chrome.storage.session);
const padRepository = api.createPadRepository(chrome.storage.local);
const reconnect = api.createReconnect(chrome, repository, visits);
const jobRepository = api.createJobRepository(chrome.storage.local);
const capture = api.createCaptureService(chrome, jobRepository, repository);
const floating = api.createFloatingService(chrome, repository, visits, capture);
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
storageReady.catch(() => {});
async function configureTab(tabId, url) {
  await chrome.sidePanel.setOptions({ tabId, path: 'panel.html', enabled: api.isBossPage(url) });
}
async function configure() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(tab => configureTab(tab.id, tab.url)));
}
chrome.runtime.onInstalled.addListener(() => { configure().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { configure().catch(console.error); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'loading') capture.invalidateSource(tabId);
  if (change.url || change.status === 'complete') configureTab(tabId, tab.url).catch(console.error);
  if (change.url && !api.isBossPage(change.url)) capture.close(tabId).catch(console.error);
});
configure().catch(console.error);
chrome.tabs.onRemoved.addListener(id => { chrome.storage.session.remove(api.VISIT_PREFIX + id).catch(console.error); });
chrome.tabs.onRemoved.addListener(id => { capture.close(id).catch(console.error); });
const CHAT_CTX_PREFIX = 'chat-ctx:';
let contactQueue = Promise.resolve();
function serialContact(task) {
  const operation = contactQueue.then(task);
  contactQueue = operation.catch(() => {});
  return operation;
}
chrome.tabs.onRemoved.addListener(id => { serialContact(() => chrome.storage.session.remove(CHAT_CTX_PREFIX + id)).catch(console.error); });
chrome.tabs.onCreated.addListener(tab => {
  if (!tab?.openerTabId || !Number.isInteger(tab.id)) return;
  serialContact(async () => {
    const parentKey = CHAT_CTX_PREFIX + tab.openerTabId;
    const parent = (await chrome.storage.session.get(parentKey))[parentKey];
    if (parent) await chrome.storage.session.set({ [CHAT_CTX_PREFIX + tab.id]: parent });
  }).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type?.startsWith('JOBS_')) {
    const reader = ['JOBS_CONTEXT', 'JOBS_SIGNAL'].includes(message.type);
    const panel = ['JOBS_STATUS', 'JOBS_START', 'JOBS_PAUSE', 'JOBS_EXPORT'].includes(message.type);
    const dashboard = message.type === 'JOBS_SUMMARY';
    if (reader ? !sender.tab || sender.frameId !== 0 || !api.isBossPage(sender.url)
      : dashboard ? sender.url !== `chrome-extension://${chrome.runtime.id}/dashboard.html`
        : !panel || sender.tab || sender.url !== `chrome-extension://${chrome.runtime.id}/panel.html`) return false;
    storageReady.then(() => capture.handle(message, sender)).then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error?.message || '采集操作失败，请重试。' }));
    return true;
  }
  if (['FLOAT_STATUS', 'FLOAT_CONTACT', 'FLOAT_VIEW', 'FLOAT_UNDO', 'FLOAT_POSITION', 'FLOAT_POSITION_SET', 'FLOAT_OPEN', 'FLOAT_COLLAPSE', 'FLOAT_SOUND_SET'].includes(message?.type)) {
    const panel = message.type === 'FLOAT_COLLAPSE';
    if (panel ? sender.tab || sender.url !== `chrome-extension://${chrome.runtime.id}/panel.html`
      : !sender.tab || sender.frameId !== 0 || !api.isBossPage(sender.url)) return false;
    let result;
    try {
      if (message.type === 'FLOAT_OPEN') {
        // Call immediately in the user-gesture message turn, before any await.
        if (!sender.tab.active) throw new Error('请在当前BOSS标签页双击。');
        result = chrome.sidePanel.open({ tabId: sender.tab.id });
      } else if (panel) {
        result = (async () => {
          if (!Number.isInteger(message.windowId)) throw new Error('无法确认当前窗口，请重试。');
          const tab = (await chrome.tabs.query({ active: true, windowId: message.windowId }))[0];
          if (!tab || !api.isBossPage(tab.url)) throw new Error('请切换到BOSS页面后再收起。');
          if (message.tabId !== undefined && (message.tabId !== tab.id || message.href !== tab.url)) throw new Error('页面已切换，请在当前页面重新点击收起。');
          function disconnected() {
            return Object.assign(new Error('页面连接尚未恢复，请点击“重新读取并收起”。'), { code: 'FLOAT_RECONNECT_REQUIRED', target: { tabId: tab.id, href: tab.url } });
          }
          let shown;
          try { shown = await chrome.tabs.sendMessage(tab.id, { type: 'FLOAT_COMPACT' }, { frameId: 0 }); }
          catch (error) { if (api.missingReader(error)) throw disconnected(); throw new Error('页面通信暂时失败，侧栏已保留，请稍后重试。'); }
          if (!shown?.shown) throw disconnected();
          const latest = (await chrome.tabs.query({ active: true, windowId: message.windowId }))[0];
          if (latest?.id !== tab.id || latest.url !== tab.url || latest.status === 'loading') throw new Error('页面已切换，请在当前页面重新点击收起。');
          if (chrome.sidePanel.close) {
            const attempts = await Promise.allSettled([
              chrome.sidePanel.close({ tabId: tab.id }),
              chrome.sidePanel.close({ windowId: message.windowId })
            ]);
            if (!attempts.some(result => result.status === 'fulfilled')) throw new Error('侧栏未能关闭，请重试；页面悬浮条已保留。');
          }
          else {
            await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
            await configureTab(tab.id, tab.url);
          }
          return { collapsed: true };
        })();
      } else {
        const task = async () => {
          await storageReady;
          return message.type === 'FLOAT_CONTACT' ? floating.mark(message, sender) : message.type === 'FLOAT_VIEW' ? floating.view(message, sender) : message.type === 'FLOAT_UNDO' ? floating.undo(message, sender) : message.type === 'FLOAT_POSITION' ? floating.position(message, sender) : message.type === 'FLOAT_POSITION_SET' ? floating.setPosition(message, sender) : message.type === 'FLOAT_SOUND_SET' ? floating.setSound(message, sender) : floating.status(message, sender);
        };
        result = ['FLOAT_CONTACT', 'FLOAT_VIEW', 'FLOAT_UNDO'].includes(message.type) ? serialContact(task) : task();
      }
    } catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error?.message || '操作失败，请重试。', code: error?.code, target: error?.target }));
    return true;
  }
  const isAuto = message?.type === 'AUTO_COMPANY_VISIT';
  const isManual = message?.type === 'MARK_JOB_COMPANY';
  const isListClick = message?.type === 'LIST_CARD_VIEW';
  const isContext = message?.type === 'READER_CONTEXT';
  const isChatSignal = ['INITIATE_CHAT', 'CHAT_SENT'].includes(message?.type);
  const isContactAction = ['MARK_CONTACTED', 'CANCEL_CONTACTED'].includes(message?.type);
  const isRestSeen = message?.type === 'REST_SEEN';
  const isDashboardRead = message?.type === 'RECORDS' && sender.url === `chrome-extension://${chrome.runtime.id}/dashboard.html`;
  if (isContext) {
    if (!sender.tab || sender.frameId !== 0 || !api.isBossPage(sender.url)) return false;
  } else if (isChatSignal || isRestSeen) {
    if (!sender.tab || sender.frameId !== 0 || !api.isBossPage(sender.url)) return false;
  } else if (isContactAction) {
    if (sender.tab || sender.url !== `chrome-extension://${chrome.runtime.id}/panel.html`) return false;
  } else if (isAuto) {
    if (!sender.tab || sender.frameId !== 0 || !api.isBossPage(sender.url) || !api.companyIdentity(sender.url)) return false;
  } else if (isListClick) {
    if (!sender.tab || sender.frameId !== 0 || !api.isBossPage(sender.url) || api.companyIdentity(sender.url)) return false;
  } else if (!isDashboardRead && (sender.tab || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`) || !['RECORDS', 'REMOVE_COMPANY', 'MARK_JOB_COMPANY', 'PAD_READ', 'PAD_SAVE', 'READ_PAGE', 'SYNC_COMPANY_NAMES'].includes(message?.type))) return false;
  if (message?.type === 'SYNC_COMPANY_NAMES' && sender.url !== `chrome-extension://${chrome.runtime.id}/panel.html`) return false;
  if (message?.type === 'READ_PAGE' && sender.url !== `chrome-extension://${chrome.runtime.id}/panel.html`) return false;
  if (message?.type?.startsWith('PAD_') && sender.url !== `chrome-extension://${chrome.runtime.id}/panel.html`) return false;
  if (isManual && sender.url !== `chrome-extension://${chrome.runtime.id}/panel.html`) return false;
  const handle = async () => {
    await storageReady;
    if (isContext) return { documentId: sender.documentId || '' };
    if (isRestSeen) {
      const updated = await repository.setRest(message.key, message.rest);
      return { updated: !!updated };
    }
    if (isChatSignal) {
      const contextKey = CHAT_CTX_PREFIX + sender.tab.id;
      if (message.type === 'INITIATE_CHAT') {
        const company = api.validCompany(message);
        const source = api.companyIdentity(sender.url) || api.jobIdentity(sender.url);
        if (!company || !source) throw new Error('当前页面无法可靠识别公司，未建立沟通上下文。');
        await chrome.storage.session.set({ [contextKey]: { ...company, at: new Date().toISOString() } });
        return { recorded: false };
      }
      const saved = (await chrome.storage.session.get(contextKey))[contextKey];
      await chrome.storage.session.remove(contextKey);
      const company = api.validCompany(saved);
      const fresh = company && Number.isFinite(Date.parse(saved.at)) && Date.now() - Date.parse(saved.at) < 600000;
      if (!fresh) return { recorded: false };
      const record = await repository.markContacted(company, 'auto');
      return { recorded: true, record };
    }
    if (message.type === 'LIST_CARD_VIEW') {
      const enabled = api.listClickViewEnabled((await chrome.storage.local.get(api.LIST_CLICK_VIEW_KEY))[api.LIST_CLICK_VIEW_KEY]);
      if (!enabled) return { recorded: false, disabled: true };
      const company = api.validCompany(message);
      if (!company || typeof message.jobKey !== 'string' || !/^job:[A-Za-z0-9_~\-]{1,128}$/.test(message.jobKey)) throw new Error('职位条目信息无效，未记录。');
      const tabId = sender.tab.id;
      async function verify() {
        const tab = await chrome.tabs.get(tabId);
        const window = await chrome.windows.get(tab.windowId);
        if (!tab.active || !window.focused || tab.url !== message.href || tab.status === 'loading') throw new Error('页面已切换或不在前台，未记录。');
        const snapshot = await chrome.tabs.sendMessage(tabId, {
          type: 'CONFIRM_LIST_CLICK',
          token: message.token,
          visitId: message.visitId,
          key: company.key,
          jobKey: message.jobKey
        }, { frameId: 0 });
        if (!snapshot || snapshot.href !== tab.url || snapshot.token !== message.token || snapshot.visitId !== message.visitId) throw new Error('职位条目已变化，未记录。');
        if (snapshot.kind !== 'detail' || snapshot.detailType !== 'job' || snapshot.source !== 'job-card-match') throw new Error('当前不是列表内职位详情，未记录。');
        if (snapshot.jobKey !== message.jobKey || !api.validCompany(snapshot.current) || snapshot.current.key !== company.key) throw new Error('当前条目与公司不一致，未记录。');
        if (sender.documentId && snapshot.documentId && sender.documentId !== snapshot.documentId) throw new Error('页面文档已变化，未记录。');
        const latest = await chrome.tabs.get(tabId);
        const latestWindow = await chrome.windows.get(latest.windowId);
        if (!latest.active || !latestWindow.focused || latest.status === 'loading' || latest.url !== message.href) throw new Error('页面已切换或不在前台，未记录。');
        return snapshot;
      }
      const snapshot = await verify();
      const history = await visits.manual(tabId, snapshot, verify);
      await chrome.tabs.sendMessage(tabId, { type: 'VISIT_RESULT', history }).catch(() => {});
      return { recorded: true, history };
    }
    if (message.type === 'MARK_CONTACTED') {
      return { record: await repository.markContacted(message, 'manual') };
    }
    if (message.type === 'CANCEL_CONTACTED') {
      if (typeof message.key !== 'string' || !message.key.startsWith('boss:')) throw new Error('公司记录无效，未取消沟通标记。');
      const contexts = await chrome.storage.session.get(null);
      for (const [key, value] of Object.entries(contexts)) {
        if (key.startsWith(CHAT_CTX_PREFIX) && api.validCompany(value)?.key === message.key) await chrome.storage.session.remove(key);
      }
      return { record: await repository.cancelContacted(message.key) };
    }
    if (message.type === 'READ_PAGE') return await reconnect.read(message);
    if (message.type === 'SYNC_COMPANY_NAMES') {
      if (!Number.isInteger(message.tabId) || !Number.isInteger(message.windowId) || !api.isBossPage(message.href) || typeof message.token !== 'string') throw new Error('名称更新页面无效，保留原记录。');
      async function activePage() {
        const tab = await chrome.tabs.get(message.tabId);
        const window = await chrome.windows.get(tab.windowId);
        if (!tab.active || !window.focused || tab.windowId !== message.windowId || tab.url !== message.href || tab.status === 'loading') throw new Error('页面已切换，保留原公司名称。');
      }
      async function verifyNames() {
        await activePage();
        const raw = await chrome.tabs.sendMessage(message.tabId, { type: 'GET_PAGE' }, { frameId: 0 });
        if (!api.validateSnapshot(raw, message.href) || raw.token !== message.token) throw new Error('公司信息已变化，保留原名称。');
        await activePage();
        return raw.kind === 'detail' ? [raw.current].filter(Boolean) : raw.kind === 'list' ? raw.companies : [];
      }
      return await visits.recover(async () => {
        const candidates = await verifyNames();
        let updated = 0;
        for (const candidate of candidates) {
          if (await repository.correctName(candidate, async () => {
            const confirmed = (await verifyNames()).find(company => company.key === candidate.key);
            if (!confirmed || confirmed.name !== candidate.name || confirmed.nameProof?.kind !== candidate.nameProof?.kind || confirmed.nameProof?.name !== candidate.name) throw new Error('名称证据已变化，未更改历史记录。');
          })) updated++;
        }
        return { updated };
      });
    }
    if (message.type === 'PAD_READ') return { pad: await padRepository.read() };
    if (message.type === 'PAD_SAVE') return await padRepository.save(message);
    if (message.type === 'RECORDS') return { records: await repository.list() };
    if (message.type === 'REMOVE_COMPANY') {
      const affected = await visits.remove(message.key);
      await Promise.allSettled(affected.map(({ tabId, history }) => chrome.tabs.sendMessage(tabId, { type: 'VISIT_RESULT', history })));
      return { removed: true };
    }
    if (isManual) {
      if (!Number.isInteger(message.tabId) || !Number.isInteger(message.windowId) || !api.isBossPage(message.href) || api.companyIdentity(message.href)) throw new Error('当前不是可标记的职位详情，未记录。');
      async function verifyManual() {
        const tab = await chrome.tabs.get(message.tabId);
        const window = await chrome.windows.get(tab.windowId);
        if (!tab.active || !window.focused || tab.windowId !== message.windowId || tab.status === 'loading' || tab.url !== message.href) throw new Error('页面已切换或不在前台，未记录。请在当前职位重新点击。');
        const snapshot = await chrome.tabs.sendMessage(message.tabId, { type: 'CONFIRM_MANUAL', token: message.token, key: message.key, visitId: message.visitId });
        const company = api.validCompany(snapshot?.current);
        if (!company || snapshot.kind !== 'detail' || snapshot.detailType !== 'job' || !['job-card-match', 'job-company-link'].includes(snapshot.source) || snapshot.href !== tab.url || snapshot.token !== message.token || snapshot.visitId !== message.visitId || !message.visitId || company.key !== message.key) throw new Error('当前职位或公司已变化，未记录。请等待详情加载后重新点击。');
        const latest = await chrome.tabs.get(message.tabId);
        const latestWindow = await chrome.windows.get(latest.windowId);
        if (!latest.active || !latestWindow.focused || latest.windowId !== message.windowId || latest.status === 'loading' || latest.url !== message.href) throw new Error('页面已切换或不在前台，未记录。请在当前职位重新点击。');
        return snapshot;
      }
      const snapshot = await verifyManual();
      const history = await visits.manual(message.tabId, snapshot, verifyManual);
      await chrome.tabs.sendMessage(message.tabId, { type: 'VISIT_RESULT', history }).catch(() => {});
      return { history };
    }
    const tabId = sender.tab.id;
    const expected = api.companyIdentity(message.href);
    if (!expected || expected.key !== message.key || message.href !== sender.url || typeof message.visitId !== 'string') throw new Error('当前不是可靠公司页，未记录。');
    async function verify() {
      const tab = await chrome.tabs.get(tabId);
      const window = await chrome.windows.get(tab.windowId);
      if (!tab.active || !window.focused || tab.url !== message.href || tab.status === 'loading') {
        const error = new Error('当前公司页未在前台或已切换，未记录。'); error.inactive = true; throw error;
      }
      const snapshot = await chrome.tabs.sendMessage(tabId, { type: 'CONFIRM_VISIT', token: message.token, key: message.key, visitId: message.visitId });
      const company = api.validCompany(snapshot?.current);
      if (!company || snapshot?.detailType !== 'company' || snapshot.source !== 'company-page' || snapshot.href !== tab.url || snapshot.visitId !== message.visitId || snapshot.token !== message.token || company.key !== expected.key) throw new Error('公司信息已变化或无法识别，未记录。请等待页面加载后重试。');
      return snapshot;
    }
    const snapshot = await verify();
    snapshot.documentId = sender.documentId;
    return { history: await visits.open(tabId, snapshot, verify) };
  };
  (isChatSignal || isContactAction || isListClick ? serialContact(handle) : handle()).then(result => respond({ ok: true, ...result }), error => respond({ ok: false, inactive: !!error?.inactive, error: error?.message || '操作失败，请重试。' }));
  return true;
});
