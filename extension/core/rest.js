(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const VALUES = ['double', 'single', 'single-double', 'shift-rest', 'rotating-rest', 'big-small-week', 'shift', 'scheduled'];
  const EXCLUDE = 'button, [role="button"], input, select, textarea, script, style, svg, template, .recommendations, .recommend-job, .job-recommend, .recommend-list, .recommend-wrap, .similar-jobs, .job-card-wrapper, .job-card-box, .job-card, .sub-li, .job-list-box, .job-list, .job-primary';
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
  function classifyText(text) {
    if (typeof text !== 'string') return null;
    const monthly = text.match(/月休\s*(\d{1,2})\s*天/);
    if (monthly && Number(monthly[1]) >= 1 && Number(monthly[1]) <= 31) return `monthly:${Number(monthly[1])}`;
    if (/单双休/.test(text)) return 'single-double';
    if (/排班轮休/.test(text)) return 'shift-rest';
    if (/大小周/.test(text)) return 'big-small-week';
    if (/单休/.test(text)) return 'single';
    if (/轮休/.test(text)) return 'rotating-rest';
    if (/轮班/.test(text)) return 'shift';
    if (/排班/.test(text)) return 'scheduled';
    if (/(?<!单)双休/.test(text)) return 'double';
    return null;
  }
  function extractRest(root) {
    const found = new Set();
    const sections = [...root.querySelectorAll('.job-sec.work-time, .work-time')].filter(visible);
    const nodes = sections.length
      ? sections.flatMap(area => [area, ...area.querySelectorAll('*')])
      : [...root.querySelectorAll('*')];
    const strict = new Set(['double', 'single', 'single-double']);
    for (const node of nodes) {
      if (!visible(node) || typeof node.closest !== 'function' || node.closest(EXCLUDE)) continue;
      const value = classifyText([...node.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent || '').join(''));
      if (value && (sections.length || strict.has(value))) found.add(value);
    }
    return found.size === 1 ? [...found][0] : null;
  }
  function validRest(value) {
    if (typeof value !== 'string') return null;
    if (VALUES.includes(value)) return value;
    const monthly = /^monthly:([1-9]|[12]\d|3[01])$/.exec(value);
    return monthly ? value : null;
  }
  function restLabel(value) {
    const labels = { double: '双休', single: '单休', 'single-double': '单双休', 'shift-rest': '排班轮休', 'rotating-rest': '轮休', 'big-small-week': '大小周', shift: '轮班', scheduled: '排班' };
    const monthly = /^monthly:(\d{1,2})$/.exec(value || '');
    if (monthly) return `月休${monthly[1]}天`;
    return labels[value] || '';
  }
  Object.assign(api, { REST_VALUES: VALUES, classifyRest: classifyText, extractRest, validRest, restLabel });
})();
