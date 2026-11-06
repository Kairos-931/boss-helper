(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const runtime = chrome.runtime;
  if (!api.isBossPage(location.href)) return;
  const recovering = !!api.recovering;
  api.recovering = false;
  const previous = api.reader;
  if (previous?.connected()) return previous.snapshot();
  const shared = previous?.dispose() || { selection: null, history: null, documentId: '', blockedVisit: '' };
  shared.state ??= api.createPageState(href => api.parsePage(document, href, shared.selection), () => location.href, crypto.randomUUID());
  shared.chatSentIds ??= new Set();
  const state = shared.state;
  let captureSessionId = null;
  let captureRevision = 0;
  let lastJobToken = '';
  let jobRequest = false;
  const jobReader = api.createJobReader?.(() => ({ href: location.href, result: api.parseJob(document, location.href, shared.selection, state.refresh()) }));
  let lastToken = '';
  let timer;
  let alive = true;
  let stopped = false;
  let historyRequest = false;
  let recoveryPending = recovering;
  let lastRestSignal = '';
  let lastInitiatedKey = '';
  let lastInitiatedAt = 0;
  let listClickPending = null;
  let listClickRequest = false;
  const listeners = [];
  const floating = api.createFloating?.({ snapshot, connected, shared });
  function connected() { try { return !stopped && !!runtime.id; } catch { return false; } }
  function visible(node) {
    for (let parent = node; parent?.nodeType === 1; parent = parent.parentElement) {
      if (parent.hidden || parent.getAttribute('aria-hidden') === 'true') return false;
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(parent.getAttribute('style') || '')) return false;
      const style = parent.ownerDocument?.defaultView?.getComputedStyle?.(parent);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  }
  function snapshot() {
    const current = state.refresh();
    return { ...current, documentId: shared.documentId, needsResume: recoveryPending, history: shared.history?.visitId === current.visitId ? shared.history : null };
  }
  function on(target, name, fn, capture = false) {
    target.addEventListener(name, fn, capture); listeners.push(() => target.removeEventListener(name, fn, capture));
  }
  function dispose() {
    if (stopped) return shared;
    stopped = true; alive = false;
    observer.disconnect(); clearInterval(interval); clearTimeout(timer);
    floating?.dispose();
    for (const remove of listeners) remove();
    try { runtime.onMessage.removeListener(receive); } catch { /* Invalid old runtime; receive itself also refuses after stop. */ }
    return shared;
  }
  function notify() {
    if (!connected()) { dispose(); return; }
    try { runtime.sendMessage({ type: 'PAGE_CHANGED' }).catch(() => { if (!connected()) dispose(); }); }
    catch { dispose(); }
    floating?.refresh();
  }
  async function syncHistory(current) {
    if (stopped || recoveryPending || shared.blockedVisit === current.visitId || historyRequest || current.detailType !== 'company' || !current.current || !current.visitId) return;
    historyRequest = true;
    try {
      const reply = await runtime.sendMessage({ type: 'AUTO_COMPANY_VISIT', href: current.href, token: current.token, visitId: current.visitId, key: current.current.key });
      if (stopped) return;
      const latest = state.refresh();
      if (latest.visitId !== current.visitId || latest.current?.key !== current.current.key) return;
      const next = reply?.ok ? reply.history : reply?.inactive ? null : { state: 'error', visitId: current.visitId, error: reply?.error || '自动记录失败，请重试。' };
      if (shared.history?.visitId === current.visitId && shared.history.state === 'suppressed' && next?.state !== 'suppressed') return;
      if (JSON.stringify(shared.history) !== JSON.stringify(next)) { shared.history = next; notify(); }
    } catch {
      if (!connected()) { dispose(); return; }
      if (!stopped && state.refresh().visitId === current.visitId) {
        shared.history = { state: 'error', visitId: current.visitId, error: '助手连接已中断，请点击重新读取。' }; notify();
      }
    } finally { historyRequest = false; }
  }
  function publish() {
    if (stopped || !alive) return;
    if (!connected()) { dispose(); return; }
    const current = state.refresh();
    if (shared.history?.visitId !== current.visitId) shared.history = null;
    if (shared.blockedVisit && shared.blockedVisit !== current.visitId) shared.blockedVisit = '';
    if (current.token !== lastToken) { lastToken = current.token; notify(); }
    reportRest(current);
    reportChatSent();
    reportListClick(current);
    reportJob();
    syncHistory(current);
    floating?.refresh();
  }
  function reportRest(current) {
    const signal = current.kind === 'detail' && current.detailType === 'company' && current.rest ? `${current.subject}:${current.rest}` : '';
    if (!signal || signal === lastRestSignal) return;
    lastRestSignal = signal;
    runtime.sendMessage({ type: 'REST_SEEN', key: current.subject, rest: current.rest }).catch(() => { if (!connected()) dispose(); });
  }
  function reportChatSent(baseline = false) {
    let added = false;
    for (const node of document.querySelectorAll('.message-item.item-myself[data-mid], .startchat-dialog .message-list .message-item')) {
      const direct = node.matches('.message-item.item-myself[data-mid]');
      const modal = !!node.closest('.startchat-dialog');
      const id = (node.getAttribute('data-mid') || node.id || '').trim();
      if (!id || (modal && (!node.querySelector('.status.success') || !visible(node) || !lastInitiatedKey || Date.now() - lastInitiatedAt > 600000))) continue;
      const key = `${direct ? 'chat' : 'startchat'}:${id}`;
      if (shared.chatSentIds.has(key)) continue;
      shared.chatSentIds.add(key);
      added = true;
    }
    if (added && !baseline) {
      runtime.sendMessage({ type: 'CHAT_SENT', href: location.href }).catch(() => { if (!connected()) dispose(); });
    }
  }
  function rememberListClick(target, jobKey) {
    if (!jobKey) return;
    const company = api.companyFromClick(target, location.href);
    listClickPending = company ? { company, jobKey, at: Date.now() } : null;
  }
  function reportListClick(current) {
    if (!listClickPending || listClickRequest) return;
    if (Date.now() - listClickPending.at > 10000) { listClickPending = null; return; }
    const pending = listClickPending;
    if (current.kind !== 'detail' || current.detailType !== 'job' || current.source !== 'job-card-match') return;
    if (current.jobKey !== pending.jobKey || current.current?.key !== pending.company.key) return;
    listClickPending = null;
    listClickRequest = true;
    runtime.sendMessage({
      type: 'LIST_CARD_VIEW',
      href: current.href,
      token: current.token,
      visitId: current.visitId,
      jobKey: pending.jobKey,
      key: pending.company.key,
      name: pending.company.name,
      url: pending.company.url
    }).then(reply => {
      if (stopped || !reply?.ok || !reply.history) return;
      const latest = state.refresh();
      if (latest.visitId === reply.history.visitId && latest.current?.key === pending.company.key) {
        shared.history = reply.history;
        notify();
      }
    }).catch(() => { if (!connected()) dispose(); })
      .finally(() => { listClickRequest = false; });
  }
  function schedule() { if (!stopped) { clearTimeout(timer); timer = setTimeout(publish, 180); } }
  function jobSnapshot() {
    if (!jobReader || !captureSessionId || recoveryPending) return null;
    return { ...jobReader.snapshot(), documentId: shared.documentId };
  }
  function reportJob() {
    if (!captureSessionId || jobRequest || recoveryPending || document.visibilityState === 'hidden') return;
    const current = jobSnapshot();
    if (!current || current.token === lastJobToken) return;
    lastJobToken = current.token; jobRequest = true;
    runtime.sendMessage({ type: 'JOBS_SIGNAL', sessionId: captureSessionId, href: current.href, token: current.token }).then(reply => {
      if (reply?.inactive) captureSessionId = null;
      if (!reply?.ok) lastJobToken = '';
    }).catch(() => { if (!connected()) dispose(); else lastJobToken = ''; }).finally(() => { jobRequest = false; });
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'class', 'hidden', 'aria-hidden', 'style', 'data-job-id', 'data-jobid', 'data-encrypt-job-id', 'data-mid'], characterData: true });
  on(document, 'click', event => {
    const selected = api.selectedJobFromClick(event.target, location.href);
    if (selected) { shared.selection = selected; schedule(); }
    rememberListClick(event.target, selected);
    reportInitiate(event.target);
  }, true);
  function reportInitiate(target) {
    const node = target?.nodeType === 1 ? target : target?.parentElement;
    const trigger = node?.closest('button, a, [role="button"]');
    if (!trigger || !/^(立即沟通|继续沟通)$/.test((trigger.textContent || '').replace(/\s+/g, ''))) return;
    const current = state.refresh();
    const key = current.current?.key;
    if (current.kind !== 'detail' || !key) return;
    const now = Date.now();
    if (key === lastInitiatedKey && now - lastInitiatedAt < 2000) return;
    lastInitiatedKey = key;
    lastInitiatedAt = now;
    reportChatSent(true);
    runtime.sendMessage({ type: 'INITIATE_CHAT', key, name: current.current.name, url: current.current.url }).catch(() => { if (!connected()) dispose(); });
  }
  on(document, 'visibilitychange', () => { if (document.visibilityState !== 'hidden') lastJobToken = ''; publish(); });
  const win = document.defaultView || globalThis;
  on(win, 'focus', () => { lastJobToken = ''; publish(); }); on(win, 'popstate', publish); on(win, 'hashchange', publish);
  on(win, 'pageshow', () => { alive = true; publish(); });
  on(win, 'pagehide', () => { alive = false; clearTimeout(timer); });
  on(win, 'unload', dispose);
  const interval = setInterval(() => { if (alive) publish(); }, 1500);
  function receive(message, sender, respond) {
    if (stopped || sender.id !== runtime.id) return false;
    if (message?.type === 'JOBS_ACTIVATE') {
      if (!jobReader || typeof message.sessionId !== 'string' || !message.sessionId || message.sessionId.length > 180 || recoveryPending) { respond({ ready: false }); return false; }
      captureSessionId = message.sessionId; lastJobToken = '';
      captureRevision++;
      respond({ ready: true }); schedule(); return false;
    }
    if (message?.type === 'JOBS_DEACTIVATE') {
      if (captureSessionId === message.sessionId) { captureSessionId = null; lastJobToken = ''; captureRevision++; }
      respond({ stopped: true }); return false;
    }
    if (message?.type === 'GET_JOB') { respond(captureSessionId === message.sessionId ? jobSnapshot() : null); return false; }
    if (message?.type === 'GET_PAGE') { respond(snapshot()); return false; }
    if (message?.type === 'CONFIRM_COMPANY') { respond(state.confirm(message.token, message.key)); return false; }
    if (message?.type === 'CONFIRM_VISIT' || message?.type === 'CONFIRM_MANUAL') {
      const confirmed = message.type === 'CONFIRM_VISIT' ? state.confirmVisit(message.token, message.key, message.visitId) : state.confirmManual(message.token, message.key, message.visitId);
      respond(confirmed ? { ...confirmed, documentId: shared.documentId } : null); return false;
    }
    if (message?.type === 'CONFIRM_LIST_CLICK') {
      const confirmed = state.confirmListClick(message.token, message.key, message.visitId, message.jobKey);
      respond(confirmed ? { ...confirmed, documentId: shared.documentId } : null); return false;
    }
    if (message?.type === 'RESUME_READER') {
      const current = state.refresh();
      if (current.token !== message.token || current.href !== message.href || current.current?.key !== message.key) { respond(null); return false; }
      shared.documentId = message.documentId || shared.documentId;
      const history = message.history;
      if (history && ['first', 'manual', 'prior', 'suppressed', 'error'].includes(history.state) && typeof history.visitId === 'string' && history.visitId && (!history.key || history.key === current.current?.key)) {
        state.restoreVisit(history.visitId); shared.history = history;
        if (history.recoveryBlocked) shared.blockedVisit = history.visitId;
      } else if (api.companyIdentity(current.href)) {
        shared.blockedVisit = current.visitId;
        shared.history = { state: 'error', visitId: current.visitId, recoveryBlocked: true, error: '连接已恢复，本次查看状态无法确认，暂未自动记录。离开后再进入公司页可记录。' };
      }
      recoveryPending = false;
      respond(snapshot()); publish(); return false;
    }
    if (message?.type === 'VISIT_RESULT') {
      const current = state.refresh();
      if (message.history?.visitId === current.visitId) { shared.history = message.history; notify(); }
      respond({ updated: true }); return false;
    }
    if (message?.type === 'RETRY_VISIT') {
      if (shared.blockedVisit === state.refresh().visitId || recoveryPending) { respond({ retrying: false }); return false; }
      shared.history = null; publish(); respond({ retrying: true }); return false;
    }
    return false;
  }
  runtime.onMessage.addListener(receive);
  api.reader = { connected, snapshot, dispose };
  try {
    runtime.sendMessage({ type: 'READER_CONTEXT' }).then(reply => {
      if (!stopped && reply?.ok && typeof reply.documentId === 'string') shared.documentId = reply.documentId;
    }).catch(() => { if (!connected()) dispose(); });
  } catch { dispose(); }
  if (jobReader) runtime.sendMessage({ type: 'JOBS_CONTEXT' }).then(reply => {
    if (!stopped && captureRevision === 0 && reply?.ok && typeof reply.sessionId === 'string' && reply.sessionId) { captureSessionId = reply.sessionId; lastJobToken = ''; schedule(); }
  }).catch(() => { if (!connected()) dispose(); });
  // Recovery never initiates an automatic write before backend page/document validation.
  publish();
  return snapshot();
})();
