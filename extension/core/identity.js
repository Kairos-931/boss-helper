(() => {
  'use strict';
  const api = globalThis.BossTracker ??= {};
  const ORIGIN = 'https://www.zhipin.com';
  function companyIdentity(href, base = ORIGIN) {
    try {
      const url = new URL(href, base);
      if (url.origin !== ORIGIN || url.username || url.password) return null;
      const match = url.pathname.match(/^\/gongsi\/(?:job\/(?:\d{2,10}\/)?)?([A-Za-z0-9_~\-]{12,128})\.html$/);
      if (!match) return null;
      return { key: `boss:${match[1]}`, url: `${ORIGIN}/gongsi/${match[1]}.html` };
    } catch { return null; }
  }
  function cleanName(name) {
    if (typeof name !== 'string') return '';
    return name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  }
  function validCompany(value) {
    if (!value || typeof value !== 'object') return null;
    const identity = companyIdentity(value.url);
    const name = cleanName(value.name);
    if (!identity || identity.key !== value.key || !name) return null;
    return { ...identity, name };
  }
  function isBossPage(href) {
    try { return new URL(href).origin === ORIGIN; } catch { return false; }
  }
  function jobIdentity(href, base = ORIGIN) {
    try {
      const url = new URL(href, base);
      if (url.origin !== ORIGIN || url.username || url.password) return null;
      const match = url.pathname.match(/^\/job_detail\/([A-Za-z0-9_~\-]{1,128})\.html$/);
      return match ? `job:${match[1]}` : null;
    } catch { return null; }
  }
  Object.assign(api, { ORIGIN, companyIdentity, jobIdentity, cleanName, validCompany, isBossPage });
})();
