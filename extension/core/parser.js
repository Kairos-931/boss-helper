(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const CARD = '.job-card-wrapper, .job-card-box, .job-card, .sub-li';
  const CLICK_CARD = `${CARD}, .job-card-wrap`;
  const DETAIL = '.job-detail, .job-detail-container, .job-detail-box, .job-sec, .job-description';
  const COMPANY_REGION = '.job-company, .sider-company, .info-company, .company-info';
  const RECOMMENDATION = '.recommendations, .recommend-job, .job-recommend, .recommend-list, .recommend-wrap, .similar-jobs, .similar-job-wrapper, .similar-job-list, .similar-job-card, .job-card-wrapper, .job-card-box, .job-card, .sub-li, .more-job-section, .omnibus-job-box, .omnibus-slider-main, .look-job-list';
  const NAME_NODE = '.company-name, .name, h3, h4';
  const ACTION = 'button, [role="button"], input, select, textarea, script, style, .favorite, .favourite, .collect, .collection, .btn-collect, .icon-collect, .icon-focus, .operate, .operation, .actions, .company-actions, .look-all, .link-more, [class*="fav"], [class*="collect"], [ka*="fav"], [ka*="collect"], [ka*="focus"]';
  function nameText(root) {
    let excluded = false;
    function read(node) {
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      if (node.matches(ACTION) || !visible(node)) { excluded = true; return ''; }
      return [...node.childNodes].map(read).join('');
    }
    return { name: api.cleanName(read(root)), excluded };
  }
  function companyName(root, heading = false) {
    const nodes = [...root.querySelectorAll(NAME_NODE)].filter(node => visible(node) && !node.closest(ACTION));
    if (root.matches(NAME_NODE)) nodes.unshift(root);
    const names = [...new Set(nodes.map(node => nameText(node).name).filter(Boolean))];
    if (names.length > 1) return null;
    if (names.length === 1) return { name: names[0], nameProof: { kind: 'name-node', name: names[0] } };
    for (const attr of ['data-company-name', 'data-brand-name']) {
      const name = api.cleanName(root.getAttribute(attr));
      if (name && !root.matches(ACTION)) return { name, nameProof: { kind: 'name-attribute', name } };
    }
    const text = nameText(root);
    const title = api.cleanName(root.getAttribute('title'));
    if (title && ((!text.name && !text.excluded) || title === text.name) && !root.matches(ACTION)) return { name: title, nameProof: { kind: 'name-attribute', name: title } };
    if (text.name) return { name: text.name, ...(heading || text.excluded ? { nameProof: { kind: heading ? 'company-heading' : 'filtered-link', name: text.name } } : {}) };
    const logo = [...root.querySelectorAll('img[alt]')].find(visible);
    const name = api.cleanName(logo?.getAttribute('alt'));
    return name ? { name } : null;
  }
  function visible(node) {
    for (let parent = node; parent?.nodeType === 1; parent = parent.parentElement) {
      if (parent.hidden || parent.getAttribute('aria-hidden') === 'true') return false;
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(parent.getAttribute('style') || '')) return false;
      const view = parent.ownerDocument?.defaultView;
      if (view?.getComputedStyle) {
        const style = view.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
    }
    return true;
  }
  function anchors(root) {
    return [...(root.matches?.('a[href]') ? [root] : []), ...root.querySelectorAll('a[href]')];
  }
  function companiesIn(root, base) {
    const result = new Map();
    const conflictingNames = new Set();
    for (const anchor of anchors(root)) {
      if (!visible(anchor)) continue;
      const identity = api.companyIdentity(anchor.getAttribute('href'), base);
      if (!identity) continue;
      if (anchor.matches(ACTION) || anchor.closest('button, .favorite, .collect, .actions')) continue;
      const named = companyName(anchor);
      if (named) {
        const previous = result.get(identity.key);
        const candidate = { ...identity, ...named };
        if (previous && previous.name !== candidate.name) conflictingNames.add(identity.key);
        if (conflictingNames.has(identity.key)) delete candidate.nameProof;
        result.set(identity.key, candidate);
      }
    }
    return [...result.values()];
  }
  function uniqueCompany(candidates) {
    const unique = new Map(candidates.map(company => [company.key, company]));
    if (unique.size !== 1) return null;
    const company = { ...[...unique.values()][0] };
    if (new Set(candidates.map(candidate => candidate.name)).size > 1) delete company.nameProof;
    return company;
  }
  const HINT_SELECTORS = '.company-info h1, .company-info .company-name, .company-banner h1, .company-banner .company-name, .sider-company .company-name, .job-company .company-name, .info-company .company-name, [data-company-name], [data-brand-name]';
  function companyNameHint(document, matchingCards = []) {
    const names = new Set();
    for (const node of document.querySelectorAll(HINT_SELECTORS)) {
      if (!visible(node) || node.closest(RECOMMENDATION) || node.closest(CARD) || node.closest(ACTION)) continue;
      const name = api.cleanName(node.getAttribute('data-company-name') || node.getAttribute('data-brand-name') || nameText(node).name);
      if (name.length >= 2) names.add(name);
    }
    for (const card of matchingCards) {
      for (const node of card.querySelectorAll('.company-name, [data-company-name], [data-brand-name]')) {
        if (!visible(node) || node.closest(ACTION)) continue;
        const name = api.cleanName(node.getAttribute('data-company-name') || node.getAttribute('data-brand-name') || nameText(node).name);
        if (name.length >= 2) names.add(name);
      }
    }
    return names.size === 1 ? [...names][0] : null;
  }
  function jobNameHint(details) {
    const names = new Set();
    for (const detail of details) {
      for (const node of detail.querySelectorAll('h1, .job-name, .job-title')) {
        if (!visible(node) || node.closest(RECOMMENDATION) || node.closest(ACTION)) continue;
        const name = nameText(node).name;
        if (name) names.add(name);
      }
    }
    return names.size === 1 ? [...names][0] : null;
  }
  function chatNameQuery(document) {
    const conversations = [...document.querySelectorAll('.chat-conversation')].filter(visible);
    if (!conversations.length) return null;
    const names = new Set();
    const jobs = new Set();
    if (conversations.length === 1) {
      for (const header of conversations[0].querySelectorAll('.top-info-content .base-info')) {
        if (!visible(header)) continue;
        const companyNode = header.querySelector('.company-name') || [...header.children].find(node => node.tagName === 'SPAN' && !node.className);
        if (!companyNode || !visible(companyNode)) continue;
        const name = nameText(companyNode).name;
        if (name.length >= 2) names.add(name);
      }
      for (const node of conversations[0].querySelectorAll('.top-info-content .chat-position-content .position-name')) {
        if (visible(node) && nameText(node).name) jobs.add(nameText(node).name);
      }
    }
    const selected = [...document.querySelectorAll('.friend-content.selected')].filter(visible);
    const selectedNames = selected.map(card => {
      const box = card.querySelector('.name-box');
      const companyNode = box && [...box.children].find(node => node.tagName === 'SPAN' && !node.className);
      return companyNode ? nameText(companyNode).name : '';
    }).filter(Boolean);
    let nameHint = names.size === 1 ? [...names][0] : null;
    if (selected.length > 1 || selectedNames.some(name => name !== nameHint)) nameHint = null;
    const jobHint = nameHint && jobs.size === 1 ? [...jobs][0] : null;
    return {
      kind: 'query', detailType: 'job', source: 'chat-name-query', current: null, companies: [], unresolved: 0,
      nameHint, jobHint, evidence: JSON.stringify([[...names], selectedNames, [...jobs]]),
      reason: nameHint ? '' : '当前会话的公司简称尚未确认，请等待会话信息加载。'
    };
  }
  function broadCompanies(root, base) {
    const result = new Map();
    for (const anchor of anchors(root)) {
      if (!visible(anchor) || anchor.closest(RECOMMENDATION) || anchor.closest(CARD)) continue;
      if (anchor.matches(ACTION) || anchor.closest('button, .favorite, .collect, .actions')) continue;
      const identity = api.companyIdentity(anchor.getAttribute('href'), base);
      if (!identity) continue;
      const named = companyName(anchor);
      const candidate = { ...identity, ...(named || {}) };
      const previous = result.get(identity.key);
      if (previous && previous.name !== candidate.name) return [];
      result.set(identity.key, candidate);
    }
    return [...result.values()];
  }
  function jobKeys(root, base, attributes = false) {
    const keys = new Set();
    for (const anchor of anchors(root)) {
      if (!visible(anchor) || anchor.closest(RECOMMENDATION)) continue;
      const key = api.jobIdentity(anchor.getAttribute('href'), base);
      if (key) keys.add(key);
    }
    if (attributes) {
      for (const node of [root, ...root.querySelectorAll('[data-job-id], [data-jobid], [data-encrypt-job-id]')]) {
        if (!visible(node) || node.closest(RECOMMENDATION)) continue;
        for (const attr of ['data-job-id', 'data-jobid', 'data-encrypt-job-id']) {
          const value = node.getAttribute(attr);
          if (value && /^[A-Za-z0-9_~\-]{1,128}$/.test(value)) keys.add(`job:${value}`);
        }
      }
    }
    return [...keys];
  }
  function cardJob(card, base) {
    const keys = new Set(anchors(card).filter(visible).map(node => api.jobIdentity(node.getAttribute('href'), base)).filter(Boolean));
    return keys.size === 1 ? [...keys][0] : null;
  }
  function clickedCard(target) {
    const node = target?.nodeType === 1 ? target : target?.parentElement;
    const card = node?.closest(CLICK_CARD);
    if (!card || !visible(card)) return null;
    return card;
  }
  function selectedJobFromClick(target, href) {
    const node = target?.nodeType === 1 ? target : target?.parentElement;
    const card = clickedCard(node);
    if (!card) return null;
    const link = node.closest('a[href]');
    if (link && !api.jobIdentity(link.getAttribute('href'), href)) return null;
    return cardJob(card, href);
  }
  function companyFromClick(target, href) {
    const node = target?.nodeType === 1 ? target : target?.parentElement;
    const card = clickedCard(node);
    if (!card) return null;
    if (node.closest('button, [role="button"], input, select, textarea, .favorite, .favourite, .collect, .collection, .actions, .operation')) return null;
    return uniqueCompany(companiesIn(card, href));
  }
  function parsePage(document, href, selection = null) {
    const empty = { kind: 'unknown', current: null, companies: [], unresolved: 0, reason: '当前页面暂无法识别公司。请进入公司或职位详情后再试。' };
    if (!api.isBossPage(href)) return { ...empty, kind: 'outside', reason: '请在 BOSS 直聘页面使用公司记录。' };
    const url = new URL(href);
    if (/\/passport\/|\/security\b/.test(url.pathname) || /请稍候|安全验证/.test(document.title)) {
      return { ...empty, reason: '页面正在验证或登录，请在 BOSS 完成后继续；工具不会绕过验证。' };
    }
    const chatQuery = chatNameQuery(document);
    if (chatQuery) return chatQuery;
    const ownIdentity = api.companyIdentity(href);
    if (ownIdentity) {
      const headings = [...document.querySelectorAll('.company-info h1, .company-info h2, .company-info .company-name, .company-banner h1, .company-banner .company-name')].filter(node => visible(node) && !node.closest(RECOMMENDATION));
      const named = headings.map(node => companyName(node, true)).filter(Boolean);
      const names = [...new Set(named.map(node => node.name))];
      const regions = [...document.querySelectorAll('.company-info, .company-banner')].filter(node => visible(node) && !node.closest(RECOMMENDATION));
      const linked = regions.flatMap(region => companiesIn(region, href));
      const conflicts = linked.some(company => company.key !== ownIdentity.key);
      const current = names.length === 1 && !conflicts ? { ...ownIdentity, ...named[0] } : null;
      const rest = api.extractRest ? api.extractRest(document) : null;
      return { ...empty, kind: 'detail', detailType: 'company', subject: ownIdentity.key, source: 'company-page', evidence: JSON.stringify([names, linked]), current, rest, reason: current ? '' : '公司身份或名称尚未唯一确认，暂不能记录。' };
    }
    const details = [...document.querySelectorAll(DETAIL)].filter(visible);
    const nestedRegions = details.length
      ? details.flatMap(root => [...root.querySelectorAll(COMPANY_REGION)].filter(node => visible(node) && !node.closest(RECOMMENDATION)))
      : [];
    const pageRegions = [...document.querySelectorAll('.sider-company, .job-company, .info-company')]
      .filter(node => visible(node) && !node.closest(RECOMMENDATION));
    const regions = [...new Set([...nestedRegions, ...pageRegions])];
    const isDetail = /^\/job_detail\//.test(url.pathname) || details.length > 0 || regions.length > 0;
    if (isDetail) {
      const candidates = regions.flatMap(root => companiesIn(root, href));
      const fallback = candidates.length || !details.length ? [] : broadCompanies(document.body || document.documentElement, href);
      const explicitKeys = [...new Set(details.flatMap(root => jobKeys(root, href, true)))];
      const routeKey = api.jobIdentity(href);
      const detailKey = explicitKeys.length === 1 ? explicitKeys[0] : routeKey;
      const conflict = explicitKeys.length > 1 || (routeKey && explicitKeys.some(key => key !== routeKey)) || (selection && detailKey !== selection);
      const matchingCards = detailKey ? [...document.querySelectorAll(CARD)].filter(card => visible(card) && cardJob(card, href) === detailKey) : [];
      const cardCandidates = matchingCards.flatMap(card => companiesIn(card, href));
      const current = conflict ? null : uniqueCompany([...candidates, ...fallback, ...cardCandidates]);
      const nameHint = current || conflict ? null : companyNameHint(document, matchingCards);
      const jobHint = nameHint ? jobNameHint(details) : null;
      return { ...empty, kind: 'detail', detailType: 'job', subject: detailKey || current?.key || '', source: cardCandidates.length ? 'job-card-match' : 'job-company-link', evidence: JSON.stringify([explicitKeys, candidates, cardCandidates, nameHint, jobHint]), current, nameHint, jobHint, reason: current ? '' : '当前职位与公司缺少可靠关联或存在冲突，暂无法识别。可打开公司详情查看。' };
    }
    const cards = [...document.querySelectorAll(CARD)].filter(node => visible(node) && !node.parentElement?.closest(CARD));
    const companies = new Map();
    let unresolved = 0;
    for (const card of cards) {
      const company = uniqueCompany(companiesIn(card, href));
      if (!company) { unresolved++; continue; }
      companies.set(company.key, company);
    }
    if (cards.length) return { kind: 'list', current: null, companies: [...companies.values()], unresolved, reason: '' };
    return empty;
  }
  Object.assign(api, { parsePage, companiesIn, broadCompanies, selectedJobFromClick, companyFromClick, companyNameHint });
})();
