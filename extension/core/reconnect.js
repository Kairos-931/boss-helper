(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const RECOVERY_FILES = ['core/identity.js', 'core/rest.js', 'core/parser.js', 'core/page-state.js', 'core/job-parser.js', 'core/sound.js', 'floating.js', 'recovery-begin.js', 'content.js'];
  function missingReader(error) {
    return /^(?:Could not establish connection\. Receiving end does not exist\.|Extension context invalidated\.)$/.test(error?.message || '');
  }
  function createReconnect(chrome, repository, visits) {
    const busy = new Set();
    async function read(message) {
      if (!Number.isInteger(message.tabId) || !Number.isInteger(message.windowId) || !api.isBossPage(message.href)) throw new Error('请在当前BOSS页面重新读取。');
      if (busy.has(message.tabId)) throw new Error('此页面正在重新读取，请稍候。');
      busy.add(message.tabId);
      async function verify() {
        const tab = await chrome.tabs.get(message.tabId);
        const window = await chrome.windows.get(tab.windowId);
        if (!tab.active || !window.focused || tab.windowId !== message.windowId || tab.status === 'loading' || tab.url !== message.href) throw new Error('页面已切换或尚在加载，请在当前页面再次点击重新读取。');
      }
      function validate(raw) {
        if (!api.validateSnapshot(raw, message.href)) throw new Error('页面信息已变化或读取未返回可靠快照，未恢复脚本。');
        return raw;
      }
      try {
        await verify();
        return await visits.recover(async () => {
        await verify();
        let existing;
        try {
          existing = validate(await chrome.tabs.sendMessage(message.tabId, { type: 'GET_PAGE' }, { frameId: 0 }));
          await verify();
          if (!existing.needsResume) return { snapshot: existing, recovered: false };
        } catch (error) {
          if (!missingReader(error)) throw error;
        }
        await verify();
        const saved = (await chrome.storage.session.get(api.VISIT_PREFIX + message.tabId))[api.VISIT_PREFIX + message.tabId];
        await verify();
        const results = existing ? [{ frameId: 0, documentId: existing.documentId, result: existing }] : await chrome.scripting.executeScript({ target: { tabId: message.tabId, frameIds: [0] }, world: 'ISOLATED', files: RECOVERY_FILES });
        await verify();
        const top = results.find(value => value.frameId === 0);
        if (!top?.documentId || !api.validateSnapshot(top.result, message.href)) throw new Error('恢复未确认当前文档，未自动记录。可再次点击重新读取。');
        const options = { documentId: top.documentId };
        const snapshot = validate(await chrome.tabs.sendMessage(message.tabId, { type: 'GET_PAGE' }, options));
        if (snapshot.token !== top.result.token) throw new Error('恢复期间页面内容已变化，未发布旧公司。请再次重新读取。');
        await verify();
        const sameDocument = saved?.documentId === top.documentId && saved.href === snapshot.href && saved.key === snapshot.current?.key;
        let history = sameDocument ? saved : snapshot.history;
        const uncertain = !history;
        if (!history && snapshot.current) {
          const record = (await repository.list()).find(value => value.key === snapshot.current.key);
          if (record) history = { state: 'prior', visitId: snapshot.visitId, key: record.key, markedAt: record.markedAt };
        }
        await verify();
        if (uncertain && api.companyIdentity(snapshot.href)) history = history ? { ...history, recoveryBlocked: true } : { state: 'error', visitId: snapshot.visitId, key: snapshot.current?.key, recoveryBlocked: true, error: '连接已恢复，本次查看状态无法确认，暂未自动记录。离开后再进入公司页可记录。' };
        if (history) {
          history = { ...history, documentId: top.documentId, href: snapshot.href, key: snapshot.current?.key };
          await chrome.storage.session.set({ [api.VISIT_PREFIX + message.tabId]: history });
        }
        await verify();
        const restored = await chrome.tabs.sendMessage(message.tabId, { type: 'RESUME_READER', token: snapshot.token, href: snapshot.href, key: snapshot.current?.key, documentId: top.documentId, history }, options);
        await verify();
        return { snapshot: validate(restored), recovered: true };
        });
      } finally { busy.delete(message.tabId); }
    }
    return { read };
  }
  Object.assign(api, { RECOVERY_FILES, missingReader, createReconnect });
})();
