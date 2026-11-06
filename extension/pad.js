(() => {
  'use strict';
  const api = globalThis.BossTracker;
  function setupPad({ document, chrome, clipboard, onCopied = null, viewport = () => globalThis.innerHeight, listen = (name, fn) => globalThis.addEventListener(name, fn), writer = crypto.randomUUID(), ResizeObserverClass = globalThis.ResizeObserver }) {
    const field = document.getElementById('pad-text');
    const status = document.getElementById('pad-status');
    const retry = document.getElementById('pad-retry');
    const copy = document.getElementById('pad-copy');
    const copied = document.getElementById('pad-copy-status');
    let base = { text: '', height: 160, revision: 0, writer: '', sequence: 0 };
    let height = 160;
    let sequence = 0;
    let copySequence = 0;
    let loaded = false;
    let conflict = false;
    let pending = 0;
    let appliedHeight = 160;
    const dirty = () => field.value !== base.text || height !== base.height;
    function state(text, action = '') {
      status.textContent = text;
      retry.hidden = !action;
      retry.textContent = action;
      status.parentElement.hidden = !text && !action;
    }
    function resize() {
      const actual = api.padHeight(height, viewport());
      appliedHeight = actual;
      field.style.minHeight = '80px';
      field.style.maxHeight = `${api.padHeight(480, viewport())}px`;
      field.style.height = `${actual}px`;
    }
    function buttons() { copy.disabled = !field.value.length; }
    function adopt(pad) {
      base = pad; field.value = pad.text; height = pad.height;
      loaded = true; field.disabled = false; conflict = false;
      resize(); buttons(); state('');
    }
    async function request(payload) {
      const reply = await chrome.runtime.sendMessage(payload);
      if (!reply?.ok) throw new Error(reply?.error || '话术保存连接失败，请重试。');
      return reply;
    }
    async function load() {
      state('正在读取话术…');
      try { adopt((await request({ type: 'PAD_READ' })).pad); }
      catch (error) { state(`读取失败：${error.message}`, '重试读取'); }
    }
    async function save(overwrite = false) {
      if (!loaded || (!overwrite && conflict)) return;
      if (overwrite) conflict = false;
      const latest = ++sequence;
      const input = { text: field.value, height, revision: base.revision, writer, sequence: latest };
      pending++; state('保存中…');
      try {
        const result = await request({ type: 'PAD_SAVE', ...input });
        if (result.pad.revision >= base.revision) base = result.pad;
        if (latest !== sequence) return;
        if (result.conflict || (base.writer !== writer && dirty())) {
          conflict = true;
          state('另一窗口已更新话术。你的输入已保留，尚未保存。', '保留我的内容');
        } else {
          conflict = false;
          state(dirty() ? '有更改尚未保存' : '', dirty() ? '重试保存' : '');
        }
      } catch (error) {
        if (latest === sequence) {
          if (conflict) state('另一窗口已更新话术。你的输入已保留，尚未保存。', '保留我的内容');
          else state(`保存失败：${error.message} 输入仍在这里。`, '重试保存');
        }
      } finally { pending--; }
    }
    field.addEventListener('input', () => { buttons(); copied.textContent = ''; save(); });
    field.addEventListener('blur', () => { if (dirty() && !pending && !conflict) save(); });
    retry.addEventListener('click', () => { if (!loaded) load(); else save(true); });
    copy.addEventListener('click', async () => {
      const text = field.value;
      if (!text.length) return;
      const ticket = ++copySequence;
      copied.textContent = '正在复制…';
      try {
        if (!clipboard?.writeText) throw new Error('Clipboard API unavailable');
        await clipboard.writeText(text);
      } catch {
        if (ticket === copySequence) copied.textContent = '复制失败，请重试，或选中文字后手动复制。';
        return;
      }
      if (ticket !== copySequence) return;
      const current = field.value === text;
      copied.textContent = current ? '已复制' : '已复制点击时的话术；内容已更改，可再次复制。';
      if (!current || !onCopied) return;
      try { await onCopied(); }
      catch { copied.textContent = '已复制；收起未完成，请点击“收起为悬浮条”。'; }
    });
    if (ResizeObserverClass) {
      const observer = new ResizeObserverClass(() => {
        if (!loaded) return;
        // Native textarea resizing changes its inline height. Layout notifications
        // alone (viewport, wrapping, programmatic restore) must not save a new preference.
        const requested = Number.parseFloat(field.style.height);
        if (!Number.isFinite(requested) || requested === appliedHeight) return;
        const previous = height;
        height = api.padHeight(requested, viewport());
        resize();
        if (height !== previous) save();
      });
      observer.observe(field);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[api.PAD_KEY] || !loaded) return;
      const pad = api.validPad(changes[api.PAD_KEY].newValue);
      if (!pad || pad.revision <= base.revision || pad.writer === writer) return;
      if (dirty() || pending) {
        base = pad; conflict = true;
        state('另一窗口已更新话术。你的输入已保留，尚未保存。', '保留我的内容');
      } else adopt(pad);
    });
    listen('resize', resize);
    listen('pagehide', () => { if (loaded && dirty() && !conflict) save(); });
    buttons(); resize();
    return { ready: load() };
  }
  Object.assign(api, { setupPad });
})();
