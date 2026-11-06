(() => {
  'use strict';
  const api = globalThis.BossTracker;
  function doubleTone(context) {
    const rate = 44100;
    const buffer = context.createBuffer(1, Math.round(rate * 0.55), rate);
    const samples = buffer.getChannelData(0);
    const notes = [[0, 0.16, 660], [0.19, 0.22, 880]];
    for (let i = 0; i < samples.length; i++) {
      const t = i / rate;
      for (const [start, length, frequency] of notes) {
        const x = t - start;
        if (x < 0 || x >= length) continue;
        const envelope = Math.min(1, x / 0.012) * Math.min(1, (length - x) / 0.04) * Math.exp(-2.4 * x / length);
        samples[i] += 0.17 * envelope * Math.sin(2 * Math.PI * frequency * x);
      }
    }
    return buffer;
  }
  function createSound({ shared = {}, current, visible, onState = () => {}, audioFactory = () => new globalThis.AudioContext() }) {
    let context, buffer, source, latest, disposed = false, blocked = false, failed = false;
    let enabled = true;
    shared.soundEncounter ??= { company: '', played: false, generation: 0 };
    const encounter = shared.soundEncounter;
    function state() { return { enabled, blocked, failed }; }
    function notify() { onState(state()); }
    function silence() {
      if (source) { try { source.stop(); source.disconnect(); } catch { /* Already ended. */ } source = null; }
    }
    function reliable(page) {
      return page?.kind === 'detail' && !!api.validCompany(page.current)
        && (page.detailType === 'company' ? page.source === 'company-page' : ['job-card-match', 'job-company-link'].includes(page.source));
    }
    function observe(page) {
      const key = reliable(page) ? page.current.key : page?.kind === 'list' ? '' : null;
      if (key !== null && key !== encounter.company) {
        silence(); encounter.company = key; encounter.played = false; encounter.generation++;
      }
      // An unresolved or changed snapshot cannot borrow the preceding company's sound.
      if (!reliable(page) || latest?.token !== page.token) latest = null;
    }
    function eligible(candidate = latest) {
      const page = current();
      return !disposed && enabled && candidate?.red && !candidate.quiet && candidate.allowed && visible() && !encounter.played
        && reliable(page) && candidate.key === page.current.key && candidate.token === page.token
        && candidate.generation === encounter.generation && !(page.detailType === 'company' && page.history?.state === 'suppressed');
    }
    function ensureContext() {
      if (!context || context.state === 'closed') { context = audioFactory(); buffer = null; }
      return context;
    }
    function attempt() {
      if (!eligible()) return;
      let next;
      try {
        const audio = ensureContext();
        if (audio.state !== 'running') { blocked = true; notify(); return; }
        buffer ??= doubleTone(audio);
        next = audio.createBufferSource();
        next.buffer = buffer; next.connect(audio.destination);
        if (!eligible() || audio.state !== 'running') { next.disconnect(); return; }
        next.onended = () => { next.disconnect(); if (source === next) source = null; };
        next.start(); source = next; encounter.played = true;
        blocked = failed = false; notify();
      } catch { if (next) { try { next.disconnect(); } catch { /* Incomplete audio node. */ } } failed = true; notify(); }
    }
    function setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      if (!enabled) silence();
      notify();
    }
    function update(view, page, allowed) {
      observe(page);
      // A new company is informational for this encounter; do not replay it later.
      if (view.quiet) encounter.played = true;
      latest = { key: page.current?.key, token: page.token, generation: encounter.generation, red: !!view.red, quiet: !!view.quiet, allowed: !!allowed };
      if (!view.red || view.quiet || !allowed || !visible()) silence();
      attempt();
    }
    function unlock() {
      // Called directly by the click handler, before any extension message/await.
      try {
        const audio = ensureContext();
        const resumed = audio.state === 'running' ? Promise.resolve() : audio.resume();
        return Promise.resolve(resumed).then(() => {
          if (disposed) return;
          blocked = audio.state !== 'running'; failed = false; notify();
          if (!blocked) attempt();
        }, () => { if (!disposed) { blocked = failed = true; notify(); } });
      } catch { failed = true; notify(); return Promise.resolve(); }
    }
    function dispose() {
      disposed = true; latest = null; silence();
      if (context && context.state !== 'closed') { try { Promise.resolve(context.close()).catch(() => {}); } catch { /* Context already gone. */ } }
      context = buffer = null;
    }
    return { observe, update, setEnabled, unlock, silence, dispose, state };
  }
  Object.assign(api, { doubleTone, createSound });
})();
