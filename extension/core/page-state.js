(() => {
  'use strict';
  const api = globalThis.BossTracker;
  function createPageState(reader, locationReader, epoch) {
    let snapshot;
    let signature;
    let generation = 0;
    let previousHref;
    let previousData;
    let waitingForChange = false;
    let visitNumber = 0;
    let visitSubject = '';
    let visitId = '';
    function refresh() {
      const href = locationReader();
      let data = reader(href);
      const dataSignature = data.evidence ?? JSON.stringify(data);
      const ownCompany = api.companyIdentity(href);
      const route = ownCompany?.url || href;
      if (previousHref !== undefined && route !== previousHref) waitingForChange = dataSignature === previousData;
      if (waitingForChange && dataSignature !== previousData) waitingForChange = false;
      if (waitingForChange) data = { kind: 'unknown', current: null, companies: [], unresolved: 0, reason: '页面正在切换，等待公司信息更新。可刷新当前页面后重试。' };
      previousHref = route;
      previousData = dataSignature;
      let subject = ownCompany ? ownCompany.key : '';
      let jobKey = '';
      if (!ownCompany && data.kind === 'detail' && data.detailType === 'job') {
        jobKey = data.subject || '';
        if (data.current) subject = `job:${route}:${data.subject || data.current.key}:${data.current.key}`;
        else if (data.subject && visitSubject.startsWith(`job:${route}:${data.subject}:`)) subject = visitSubject;
      }
      if (subject !== visitSubject) {
        visitSubject = subject;
        visitId = subject ? `${epoch}:visit:${++visitNumber}` : '';
      }
      data = { ...data, jobKey, visitId };
      const next = JSON.stringify([href, data]);
      if (signature !== next) {
        generation++;
        signature = next;
        snapshot = { ...data, token: `${epoch}:${generation}`, href };
      }
      return snapshot;
    }
    function confirm(token, key) {
      const current = refresh();
      if (current.token !== token || current.kind !== 'detail' || current.current?.key !== key) return null;
      return current.current;
    }
    function confirmVisit(token, key, id) {
      const current = refresh();
      const identity = api.companyIdentity(current.href);
      if (current.token !== token || current.visitId !== id || current.detailType !== 'company' || current.source !== 'company-page' || !identity || identity.key !== key || current.current?.key !== key) return null;
      return current;
    }
    function confirmManual(token, key, id) {
      const current = refresh();
      if (current.token !== token || current.visitId !== id || !id || current.kind !== 'detail' || current.detailType !== 'job' || api.companyIdentity(current.href) || !['job-card-match', 'job-company-link'].includes(current.source) || !api.validCompany(current.current) || current.current.key !== key) return null;
      return current;
    }
    function confirmListClick(token, key, id, jobKey) {
      const current = refresh();
      if (current.token !== token || current.visitId !== id || !id || typeof jobKey !== 'string' || !jobKey) return null;
      if (current.kind !== 'detail' || current.detailType !== 'job' || current.source !== 'job-card-match') return null;
      if (!api.validCompany(current.current) || current.current.key !== key || current.jobKey !== jobKey) return null;
      return current;
    }
    function restoreVisit(id) {
      if (typeof id !== 'string' || !id || !refresh().visitId) return false;
      visitId = id; signature = null; refresh(); return true;
    }
    return { refresh, confirm, confirmVisit, confirmManual, confirmListClick, restoreVisit };
  }
  function validateSnapshot(data, currentHref) {
    if (!data || !api.isBossPage(data.href) || data.href !== currentHref || typeof data.token !== 'string') return null;
    if (!['list', 'detail', 'query', 'unknown', 'outside'].includes(data.kind)) return null;
    const queryOnly = data.kind === 'query';
    const current = queryOnly ? null : api.validCompany(data.current);
    const companies = !queryOnly && Array.isArray(data.companies) ? data.companies.map(api.validCompany).filter(Boolean).slice(0, 1000) : [];
    const nameHint = !current && ['detail', 'query'].includes(data.kind) ? api.cleanName(data.nameHint).slice(0, 60) : '';
    const jobHint = nameHint.length >= 2 ? api.cleanName(data.jobHint) : '';
    return {
      href: data.href, token: data.token, kind: data.kind, current,
      detailType: !queryOnly && data.detailType === 'company' ? 'company' : 'job',
      source: typeof data.source === 'string' ? data.source : '',
      rest: queryOnly ? null : api.validRest?.(data.rest) || null,
      nameHint: nameHint.length >= 2 ? nameHint : null,
      jobHint: jobHint || null,
      visitId: typeof data.visitId === 'string' ? data.visitId : '',
      history: !queryOnly && data.history && ['first', 'manual', 'prior', 'suppressed', 'error'].includes(data.history.state) && data.history.visitId === data.visitId ? { state: data.history.state, visitId: data.history.visitId, markedAt: data.history.markedAt, recoveryBlocked: !!data.history.recoveryBlocked, error: typeof data.history.error === 'string' ? data.history.error.slice(0, 250) : '' } : null,
      companies, unresolved: Math.max(0, Number(data.unresolved) || 0),
      reason: typeof data.reason === 'string' ? data.reason.slice(0, 250) : ''
    };
  }
  Object.assign(api, { createPageState, validateSnapshot });
})();
