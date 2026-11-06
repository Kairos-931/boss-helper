(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const LIST_CLICK_VIEW_KEY = 'settings:list-click-view';
  function listClickViewEnabled(value) {
    return value === true;
  }
  Object.assign(api, { LIST_CLICK_VIEW_KEY, listClickViewEnabled });
})();
