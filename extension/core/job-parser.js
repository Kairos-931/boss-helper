(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const EXCLUDED = 'script, style, noscript, button, [role="button"], .recommendations, .recommend-job, .recommend-list, .similar-jobs, .similar-job-list, .more-job-section, .omnibus-job-box, .omnibus-slider-main, .look-job-list, .smallbanner, .job-boss-info, .boss-info, .chat-conversation';
  const CARDS = '.job-card-wrap, .job-card-wrapper, .job-card-box, .job-card, .sub-li';
  function visible(node) {
    for (let p = node; p?.nodeType === 1; p = p.parentElement) {
      if (p.hidden || p.getAttribute('aria-hidden') === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(p.getAttribute('style') || '')) return false;
      const style = p.ownerDocument?.defaultView?.getComputedStyle?.(p);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  }
  function text(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 || node.matches(EXCLUDED) || !visible(node)) return '';
    if (node.tagName === 'BR') return '\n';
    const result = [...node.childNodes].map(text).join('');
    return /^(P|DIV|LI|SECTION|H[1-6])$/.test(node.tagName) ? `${result}\n` : result;
  }
  function clean(value) { return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
  function nodes(root, selector) { return [...root.querySelectorAll(selector)].filter(n => visible(n) && !n.closest(EXCLUDED)); }
  function uniqueText(list) {
    const values = [...new Set(list.map(n => clean(text(n))).filter(Boolean))];
    return values.length === 1 ? values[0] : '';
  }
  function links(root, href) {
    return nodes(root, 'a[href]').filter(n => !n.closest(CARDS)).map(n => {
      const key = api.jobIdentity(n.getAttribute('href'), href);
      if (!key) return null;
      const url = new URL(n.getAttribute('href'), href);
      return { key, url: url.origin + url.pathname };
    }).filter(Boolean);
  }
  function parseJob(document, href, selection = null, page = null) {
    const wait = reason => ({ state: 'waiting', reason, job: null });
    if (!api.isBossPage(href) || api.companyIdentity(href) || /\/passport\/|\/security\b|\/web\/geek\/chat/.test(new URL(href).pathname) || /安全验证|请稍候/.test(document.title)) return { state: 'outside', reason: '请在本页打开具体岗位。', job: null };
    if (nodes(document, '.chat-conversation').length) return { state: 'outside', reason: '聊天页面不采集岗位资料。', job: null };
    let roots = nodes(document, '.job-detail-box');
    if (!roots.length) roots = nodes(document, '.job-detail-container, .job-detail').filter(n => !n.closest(CARDS));
    roots = roots.filter(n => !roots.some(other => other !== n && n.contains(other)));
    if (roots.length !== 1) return wait(roots.length ? '存在多个职位详情，等待唯一岗位。' : '请打开具体岗位，显示详情后自动采集。');
    const root = roots[0];
    const routeKey = api.jobIdentity(href);
    const references = links(root, href);
    const keys = [...new Set(references.map(v => v.key))];
    if (keys.length > 1 || (routeKey && keys.some(k => k !== routeKey))) return wait('岗位链接存在冲突，等待详情更新。');
    let key = keys[0] || routeKey;
    const attrs = nodes(root, '[data-job-id], [data-jobid], [data-encrypt-job-id]');
    if (root.matches('[data-job-id], [data-jobid], [data-encrypt-job-id]')) attrs.unshift(root);
    const explicit = [...new Set(attrs.flatMap(n => ['data-job-id', 'data-jobid', 'data-encrypt-job-id'].map(a => n.getAttribute(a)).filter(v => v && /^[A-Za-z0-9_~\-]{1,128}$/.test(v)).map(v => `job:${v}`)))];
    // Attribute values alone never become invented public URLs: require an actual matching link.
    if (!key && explicit.length === 1) {
      const matching = nodes(document, `${CARDS.split(', ').map(s => `${s} a[href]`).join(', ')}`).map(n => ({ key: api.jobIdentity(n.getAttribute('href'), href), node: n })).filter(v => v.key === explicit[0]);
      if (matching.length) { key = explicit[0]; const url = new URL(matching[0].node.getAttribute('href'), href); references.push({ key, url: url.origin + url.pathname }); }
    }
    if (!key) return wait('缺少具体岗位链接，暂未采集；可打开独立职位页再试。');
    if (selection && selection !== key) return wait('正在切换岗位，等待新详情与链接一致。');
    if (!references.length && explicit.length && !explicit.includes(key)) return wait('岗位详情与地址不一致，等待更新。');
    let name = uniqueText(nodes(root, '.job-detail-info .job-name, .job-header-info .job-name, h1.job-name, .job-title h1, h1'));
    const banners = routeKey ? nodes(document, '.job-banner, .job-primary').filter(n => !n.closest(CARDS)) : [];
    if (!name) name = uniqueText(banners.flatMap(n => nodes(n, '.name h1, h1, .job-name')));
    if (!name) return wait('职位名称尚未唯一确认，等待详情加载。');
    const matchingCards = nodes(document, CARDS).filter(card => [...card.querySelectorAll('a[href]')].some(n => api.jobIdentity(n.getAttribute('href'), href) === key));
    const cardNames = matchingCards.map(c => uniqueText(nodes(c, 'a.job-name, .job-title .job-name, [data-job-name]'))).filter(Boolean);
    if (cardNames.some(value => value !== name)) return wait('职位标题与卡片不一致，等待详情更新。');
    let description = '';
    for (const selector of ['.job-detail-body > .desc', '.job-sec-text', '.job-description']) {
      description = uniqueText(nodes(root, selector).filter(n => !n.closest('.company-info-box, .company-intro, .company-business')));
      if (description) break;
    }
    if (!description) return wait('岗位描述尚未加载，等待完整资料。');
    if (description.length > 60000) return wait('岗位描述过长，暂未采集；请联系开发核对。');
    const primary = nodes(root, '.job-detail-header');
    const headers = primary.length ? primary : banners.length ? banners : [root];
    const salary = uniqueText(headers.flatMap(n => nodes(n, '.job-salary, .salary')));
    const tags = headers.flatMap(n => nodes(n, '.job-header-info > .tag-list > li, .tag-list > li, .job-limit > span')).map(n => clean(text(n))).filter(Boolean);
    const info = headers.flatMap(n => nodes(n, '.text-city, .job-area, [data-city]'));
    const city = uniqueText(info) || (tags.length === 3 ? tags[0] : '');
    const experience = [...new Set(tags.filter(v => /经验|应届|在校|\d+\s*[-~至]\s*\d+\s*年|\d+年以上/.test(v)))];
    const education = [...new Set(tags.filter(v => /学历|博士|硕士|研究生|本科|大专|中专|高中|初中/.test(v)))];
    const company = page?.kind === 'detail' && page.detailType === 'job' && page.jobKey === key ? api.validCompany(page.current) : null;
    return { state: 'ready', reason: '', job: {
      key, url: references.find(v => v.key === key)?.url || new URL(href).origin + new URL(href).pathname,
      name, salary, city, experience: experience.length === 1 ? experience[0] : '', education: education.length === 1 ? education[0] : '', description,
      company, companyName: company?.name || (page?.jobKey === key ? api.cleanName(page.nameHint) : ''),
      source: 'visible-page'
    } };
  }
  function createJobReader(read, clock = () => Date.now()) {
    const epoch = crypto.randomUUID();
    let generation = 0, signature = '', candidate = '', candidateAt = 0, accepted = null;
    return { snapshot() {
      let reading = read();
      const job = reading.result.job;
      const nextCandidate = JSON.stringify([reading.href, reading.result]);
      if (nextCandidate !== candidate) { candidate = nextCandidate; candidateAt = clock(); }
      if (job && accepted && job.key !== accepted.key && job.description === accepted.description) {
        reading = { ...reading, result: { state: 'waiting', reason: '等待新岗位描述更新；若两个岗位描述相同，请打开独立职位页采集。', job: null } };
      } else if (job && clock() - candidateAt < 350) {
        reading = { ...reading, result: { state: 'waiting', reason: '正在确认岗位资料，稍后自动采集。', job: null } };
      } else if (job) accepted = { key: job.key, description: job.description };
      const next = JSON.stringify([reading.href, reading.result]);
      if (next !== signature) { signature = next; generation++; }
      return { ...reading.result, href: reading.href, token: `${epoch}:${generation}` };
    } };
  }
  Object.assign(api, { parseJob, createJobReader });
})();
