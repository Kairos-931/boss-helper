(() => {
  'use strict';
  const api = globalThis.BossTracker;
  api.createFloating = ({ snapshot, connected, shared = {} }) => {
    const BALL_SIZE = 42, EDGE = 12, DRAG_THRESHOLD = 5;
    const viewport = () => {
      const view = document.defaultView || globalThis;
      return {
        width: Math.max(BALL_SIZE, Number(view?.innerWidth) || 1024),
        height: Math.max(BALL_SIZE, Number(view?.innerHeight) || 768)
      };
    };
    function clampPosition(value) {
      const size = viewport();
      return {
        x: Math.min(Math.max(0, Math.round(value.x)), size.width - BALL_SIZE),
        y: Math.min(Math.max(0, Math.round(value.y)), size.height - BALL_SIZE)
      };
    }
    let position = clampPosition({ x: viewport().width - BALL_SIZE - EDGE, y: viewport().height * 0.45 });
    const host = document.createElement('div');
    host.id = 'boss-helper-floating';
    host.style.cssText = `all:initial!important;font:14px/1.4 system-ui,sans-serif!important;color:#242735!important;position:fixed!important;left:${position.x}px!important;top:${position.y}px!important;right:auto!important;transform:none!important;z-index:2147483647!important;display:block!important;width:${BALL_SIZE}px!important;height:${BALL_SIZE}px!important;max-width:none!important;overflow:visible!important;pointer-events:auto!important;color-scheme:light!important;`;
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host{font:14px/1.4 system-ui,sans-serif;color:#242735}
      *{box-sizing:border-box} [hidden]{display:none!important}
      .wrap{position:absolute;inset:0;width:42px;height:42px;display:block;max-width:none}
      button{font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #b8bdfa;outline-offset:2px}
      .ball{position:relative;z-index:2;flex:none;width:42px;height:42px;border:1px solid #fff;border-radius:50%;background:#5964b6;color:#fff;box-shadow:0 2px 12px #23285030;font-size:14px;user-select:none;cursor:grab;touch-action:none}
      .ball.dragging{cursor:grabbing}
      .ball.red{background:#c83a47}.ball.green{background:#2f8b5f}.ball.unknown{background:#727887}
      .ball.capture{background:#2b5d7a;font-weight:700}.ball.capture.unknown{background:#727887}
      .strip{position:absolute;z-index:1;top:50%;right:calc(100% + 6px);transform:translateY(-50%);min-width:0;width:max-content;max-width:min(270px,calc(100vw - 66px));max-height:calc(100vh - 24px);overflow:auto;padding:10px 12px;background:#fff;border:1px solid #e2e4ec;border-radius:12px;box-shadow:0 3px 16px #23285024;margin:0}
      .wrap.strip-right .strip{left:calc(100% + 6px);right:auto}
      .name{font-weight:600;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .status{font-size:12px;color:#62697a;margin:3px 0 6px}.status.red{color:#b82435}.status.green{color:#1f6b48}
      .status.capture{color:#2b5d7a}
      .when{font-size:11px;color:#62697a;margin:-3px 0 6px}
      .capture-info{font-size:11px;color:#62697a;margin:-2px 0 2px;max-width:230px;white-space:pre-line;overflow-wrap:anywhere}.capture-info.error{color:#b82435}
      .contact{background:#f0f1fb;color:#39468e;border:0;border-radius:6px;padding:5px 8px}
      .contact:disabled{opacity:.55;cursor:default}.undo{background:#fff1f2;color:#a12f3c;border:0;border-radius:6px;padding:5px 8px;margin-left:6px}
      .undo:disabled{opacity:.55;cursor:default}.hint{font-size:11px;color:#777d8b;margin-top:5px}
      .feedback{font-size:12px;color:#b82435;max-width:230px;margin-top:5px;overflow-wrap:anywhere}
    `;
    function node(tag, className, text) {
      const el = document.createElement(tag); el.className = className;
      if (text) el.textContent = text;
      return el;
    }
    const wrap = node('div', 'wrap');
    const strip = node('div', 'strip');
    const name = node('div', 'name', 'BOSS 助手');
    const status = node('div', 'status', '正在识别');
    const when = node('div', 'when');
    const captureInfo = node('div', 'capture-info'); captureInfo.setAttribute('role', 'status');
    const contact = node('button', 'contact', '标记已查看');
    const undo = node('button', 'undo', '撤销本次记录');
    const feedback = node('div', 'feedback'); feedback.setAttribute('role', 'status');
    const hint = node('div', 'hint', '按住可拖动 · 双击打开完整侧栏');
    const soundButton = node('button', 'contact sound-toggle', '提示音：开');
    soundButton.setAttribute('aria-pressed', 'true');
    const unlockSound = node('button', 'contact sound-unlock', '启用声音'); unlockSound.hidden = true;
    const soundStatus = node('div', 'hint sound-status'); soundStatus.setAttribute('role', 'status');
    const ball = node('button', 'ball', '助');
    ball.type = contact.type = undo.type = soundButton.type = unlockSound.type = 'button';
    ball.setAttribute('aria-label', 'BOSS助手，双击打开完整侧栏');
    strip.append(name, status, when, captureInfo, contact, undo, soundButton, unlockSound, soundStatus, feedback, hint);
    wrap.append(strip, ball); root.append(style, wrap);
    strip.hidden = true; contact.hidden = true; undo.hidden = true; captureInfo.hidden = true;
    document.documentElement.append(host);
    let disposed = false, hovering = false, focused = false, pinned = false, busy = false, reading = false;
    let lastView = '', currentView = null, busyAction = '', target = '', actionFeedback = '', ticket = 0, ballTimer = 0;
    let dragging = false, drag = null, suppressClickUntil = 0, positionRevision = 0, positionTimer = 0, positionCustomized = false;
    let positionSaveRunning = false, positionSaveAgain = false;
    const listeners = [];
    const runtime = chrome.runtime;
    let soundBusy = false, soundRevision = 0;
    const sound = api.createSound?.({
      shared, current: snapshot,
      visible: () => document.visibilityState !== 'hidden' && (!document.hasFocus || document.hasFocus()),
      onState(state) {
        soundButton.textContent = state.enabled ? '提示音：开' : '提示音：关';
        soundButton.setAttribute('aria-pressed', String(state.enabled));
        unlockSound.hidden = !state.enabled || !(state.blocked || state.failed);
        unlockSound.textContent = state.failed ? '重试启用声音' : '启用声音';
        soundStatus.textContent = state.enabled && (state.blocked || state.failed) ? `声音尚未启用，请点击“${unlockSound.textContent}”。` : '';
      }
    });
    soundButton.hidden = !sound;
    function on(el, event, fn) { el.addEventListener(event, fn); listeners.push(() => el.removeEventListener(event, fn)); }
    function placeStrip() {
      if (strip.hidden) { strip.style.top = ''; strip.style.transform = ''; return; }
      const view = document.defaultView || globalThis;
      const height = Number(strip.getBoundingClientRect?.().height) || Number(strip.offsetHeight) || 0;
      if (!height) { strip.style.top = '50%'; strip.style.transform = 'translateY(-50%)'; return; }
      const viewportHeight = Number(view?.innerHeight) || 768;
      const minTop = 8;
      const maxTop = Math.max(minTop, viewportHeight - height - 8);
      const screenTop = Math.min(Math.max(position.y + BALL_SIZE / 2 - height / 2, minTop), maxTop);
      strip.style.top = `${Math.round(screenTop - position.y)}px`;
      strip.style.transform = 'none';
    }
    function layout() {
      const width = viewport().width;
      wrap.classList.toggle('strip-right', position.x + BALL_SIZE / 2 < width / 2);
      placeStrip();
    }
    function expanded() {
      const shouldShow = hovering || focused || pinned || busy || actionFeedback;
      strip.hidden = !shouldShow || dragging;
      ball.setAttribute('aria-expanded', String(!strip.hidden));
      layout();
    }
    function applyPosition(value) {
      const next = clampPosition(value);
      const changed = next.x !== position.x || next.y !== position.y;
      position = next;
      host.style.setProperty('left', `${position.x}px`, 'important');
      host.style.setProperty('top', `${position.y}px`, 'important');
      layout();
      return changed;
    }
    async function persistPosition() {
      if (disposed) return;
      if (positionSaveRunning) { positionSaveAgain = true; return; }
      positionSaveRunning = true;
      try {
        do {
          positionSaveAgain = false;
          const revision = positionRevision;
          try {
            await send({ type: 'FLOAT_POSITION_SET', x: position.x, y: position.y });
          } catch (error) {
            if (!disposed && revision === positionRevision) {
              actionFeedback = `位置未保存：${error.message}`;
              feedback.textContent = actionFeedback;
              expanded();
            }
          }
        } while (positionSaveAgain && !disposed);
      } finally {
        positionSaveRunning = false;
        if (positionSaveAgain && !disposed) {
          positionSaveAgain = false;
          persistPosition();
        }
      }
    }
    function queuePositionSave() {
      clearTimeout(positionTimer);
      positionTimer = setTimeout(() => { positionTimer = 0; persistPosition(); }, 180);
    }
    async function loadPosition() {
      const revision = positionRevision;
      try {
        const reply = await send({ type: 'FLOAT_POSITION' });
        if (disposed || dragging || revision !== positionRevision || !reply.position) return;
        positionCustomized = true;
        if (applyPosition(reply.position)) queuePositionSave();
      } catch {
        // Keep the default position; dragging remains available and will retry the save.
      }
    }
    function context(page) { return { href: page.href, token: page.token, visitId: page.visitId, key: page.current?.key }; }
    function signature(page) { return JSON.stringify(context(page)); }
    function render(view) {
      const next = JSON.stringify([view, busy, busyAction, actionFeedback]);
      if (lastView === next) return;
      lastView = next;
      currentView = view;
      if (view.mode === 'capture') {
        name.textContent = view.name; name.title = view.name;
        status.textContent = view.label;
        status.className = 'status capture';
        when.textContent = view.sessionCount === null ? '本次数读取失败' : `本次已采集 ${view.countText} 个岗位`;
        when.hidden = false;
        captureInfo.textContent = [
          `本次新增 ${view.added} · 更新 ${view.updated} · 未成功 ${view.failed}`,
          view.total === null ? '累计数读取失败' : `累计 ${view.totalText} 个岗位`,
          view.recent
        ].filter(Boolean).join('\n');
        captureInfo.className = view.totalError || view.recentError ? 'capture-info error' : 'capture-info';
        captureInfo.hidden = false;
        ball.textContent = view.countText;
        ball.className = view.unavailable ? 'ball capture unknown' : 'ball capture';
        if (dragging) ball.classList.add('dragging');
        ball.title = `${view.name} · ${view.label} · ${when.textContent}${view.recent ? ` · ${view.recent}` : ''}；按住可拖动，双击打开侧栏`;
        ball.setAttribute('aria-label', ball.title);
        contact.hidden = true; undo.hidden = true;
        soundButton.hidden = true; unlockSound.hidden = true; soundStatus.textContent = '';
        feedback.textContent = actionFeedback;
        expanded();
        return;
      }
      name.textContent = view.name; name.title = view.name;
      status.textContent = view.label;
      status.className = view.red ? 'status red' : view.green ? 'status green' : 'status';
      when.textContent = view.seenAt ? `查看：${view.seenAt}` : '';
      when.hidden = !view.seenAt;
      captureInfo.hidden = true; captureInfo.textContent = '';
      ball.textContent = '助';
      ball.className = view.red ? 'ball red' : view.green ? 'ball green' : view.unavailable ? 'ball unknown' : 'ball';
      if (dragging) ball.classList.add('dragging');
      const singleHint = view.canView ? '单击标记已查看' : view.canUndo ? '单击展开撤销' : '单击查看状态';
      ball.title = `${view.name} · ${view.label}${view.seenAt ? ` · 查看：${view.seenAt}` : ''}；按住可拖动，${singleHint}，双击打开侧栏`;
      ball.setAttribute('aria-label', ball.title);
      contact.hidden = !view.canView && !view.canContact; contact.disabled = busy;
      contact.textContent = busy && busyAction !== 'undo' ? '保存中…' : view.canView ? '标记已查看' : '标记已沟通';
      undo.hidden = !view.canUndo; undo.disabled = busy;
      undo.textContent = busy && busyAction === 'undo' ? '撤销中…' : '撤销本次记录';
      soundButton.hidden = !sound;
      if (sound) {
        const state = sound.state();
        unlockSound.textContent = state.failed ? '重试启用声音' : '启用声音';
        unlockSound.hidden = !state.enabled || !(state.blocked || state.failed);
        soundStatus.textContent = state.enabled && (state.blocked || state.failed) ? `声音尚未启用，请点击“${unlockSound.textContent}”。` : '';
      } else {
        unlockSound.hidden = true; soundStatus.textContent = '';
      }
      feedback.textContent = actionFeedback;
      expanded();
    }
    const unknown = label => ({ name: 'BOSS 助手', label, red: false, green: false, canView: false, canUndo: false, canContact: false, unavailable: true, seenAt: '' });
    async function send(payload) {
      const result = await runtime.sendMessage(payload);
      if (!result?.ok) {
        const error = new Error(result?.error || '连接中断，请从扩展图标打开侧栏重新读取。');
        if (result?.code) error.code = result.code;
        throw error;
      }
      return result;
    }
    async function refresh() {
      if (disposed) return;
      if (!connected()) { dispose(); return; }
      const page = snapshot();
      sound?.observe(page);
      const key = signature(page);
      if (target !== key) { target = key; ++ticket; actionFeedback = ''; render(unknown('正在识别')); }
      if (reading) return;
      reading = true; const request = ++ticket, preferenceRequest = soundRevision;
      try {
        const reply = await send({ type: 'FLOAT_STATUS', ...context(page) });
        if (!disposed && request === ticket && signature(snapshot()) === key) {
          render(reply.view);
          if (reply.view.mode === 'capture') {
            sound?.silence();
            sound?.update({ red: false, quiet: true }, page, false);
          } else {
            if (!soundBusy && preferenceRequest === soundRevision) sound?.setEnabled(reply.soundEnabled !== false);
            sound?.update(reply.view, page, reply.soundAllowed);
          }
        }
      } catch (error) {
        if (!connected()) { dispose(); return; }
        if (!disposed && request === ticket) {
          render(unknown(error.code === 'FLOAT_STATUS_RETRY' ? '页面正在更新，稍后自动重试' : error.message));
          sound?.update({ red: false }, snapshot(), false);
        }
      } finally { reading = false; }
    }
    on(wrap, 'mouseenter', () => { hovering = true; expanded(); refresh(); });
    on(wrap, 'mouseleave', () => { hovering = false; actionFeedback = ''; feedback.textContent = ''; expanded(); });
    on(wrap, 'focusin', () => { focused = true; expanded(); });
    on(wrap, 'focusout', event => { if (!wrap.contains(event.relatedTarget)) { focused = false; expanded(); } });
    on(wrap, 'keydown', event => {
      if (event.key === 'Escape') { hovering = focused = pinned = false; actionFeedback = ''; ball.blur(); expanded(); }
    });
    // Keep our controls out of the site's bubbling click handlers.
    on(wrap, 'click', event => event.stopPropagation());
    function dragPoint(event) {
      return {
        x: Number.isFinite(event.clientX) ? event.clientX : 0,
        y: Number.isFinite(event.clientY) ? event.clientY : 0
      };
    }
    function endDrag(event) {
      if (!drag) return;
      if (event && drag.id !== null && Number.isInteger(event.pointerId) && event.pointerId !== drag.id) return;
      const moved = drag.moved, pointerId = drag.id;
      drag = null; dragging = false;
      ball.classList.remove('dragging');
      try { ball.releasePointerCapture?.(pointerId); } catch { /* Pointer capture may already be gone. */ }
      if (moved) {
        positionCustomized = true;
        ++positionRevision;
        suppressClickUntil = Date.now() + 400;
        persistPosition();
      }
      expanded();
    }
    on(ball, 'pointerdown', event => {
      if (disposed || (event.button !== undefined && event.button !== 0)) return;
      clearTimeout(ballTimer); ballTimer = 0;
      suppressClickUntil = 0;
      const point = dragPoint(event);
      drag = { id: Number.isInteger(event.pointerId) ? event.pointerId : null, startX: point.x, startY: point.y, x: position.x, y: position.y, moved: false };
      try { ball.setPointerCapture?.(event.pointerId); } catch { /* Linkedom and older browsers may not support capture. */ }
    });
    on(document, 'pointermove', event => {
      if (!drag || (drag.id !== null && Number.isInteger(event.pointerId) && event.pointerId !== drag.id)) return;
      const point = dragPoint(event);
      const dx = point.x - drag.startX, dy = point.y - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true; dragging = true;
        positionCustomized = true; ++positionRevision;
        hovering = false; actionFeedback = ''; feedback.textContent = '';
        ball.classList.add('dragging');
        expanded();
      }
      event.preventDefault?.();
      applyPosition({ x: drag.x + dx, y: drag.y + dy });
    });
    on(document, 'pointerup', endDrag);
    on(document, 'pointercancel', endDrag);
    on(document.defaultView || globalThis, 'resize', () => {
      if (disposed) return;
      const changed = positionCustomized
        ? applyPosition(position)
        : applyPosition({ x: viewport().width - BALL_SIZE - EDGE, y: viewport().height * 0.45 });
      if (changed && positionCustomized) queuePositionSave();
    });
    on(soundButton, 'click', async () => {
      if (!sound || soundBusy || disposed) return;
      const before = sound.state();
      const enable = !before.enabled;
      soundBusy = true; soundButton.disabled = true; ++soundRevision;
      sound.setEnabled(enable);
      // Resume in this click, before awaiting persistence or refreshing the page.
      const unlocked = enable ? sound.unlock() : Promise.resolve();
      try {
        await send({ type: 'FLOAT_SOUND_SET', ...context(snapshot()), enabled: enable });
        await unlocked;
      } catch (error) {
        sound.setEnabled(before.enabled);
        actionFeedback = `提示音设置未保存：${error.message}`; feedback.textContent = actionFeedback;
      } finally { soundBusy = false; soundButton.disabled = false; refresh(); }
    });
    on(unlockSound, 'click', () => {
      if (!sound || soundBusy || disposed) return;
      soundBusy = true; unlockSound.disabled = true;
      sound.unlock().finally(() => { soundBusy = false; unlockSound.disabled = false; refresh(); });
    });
    on(document, 'visibilitychange', () => sound?.silence());
    on(document.defaultView || globalThis, 'blur', () => sound?.silence());
    on(document.defaultView || globalThis, 'blur', endDrag);
    async function open() {
      try {
        await send({ type: 'FLOAT_OPEN' });
        if (!disposed) { pinned = false; hovering = false; focused = false; ball.blur(); expanded(); }
      } catch (error) { actionFeedback = error.message; feedback.textContent = actionFeedback; expanded(); }
    }
    async function act(type, failure = '未保存') {
      if (disposed || busy) return;
      const page = snapshot();
      if (signature(page) !== target) { refresh(); return; }
      busy = true; busyAction = type === 'FLOAT_UNDO' ? 'undo' : 'save';
      contact.disabled = true; undo.disabled = true;
      if (busyAction === 'undo') undo.textContent = '撤销中…'; else contact.textContent = '保存中…';
      actionFeedback = ''; feedback.textContent = ''; expanded();
      try {
        await send({ type, ...context(page) });
      } catch (error) {
        if (signature(snapshot()) === signature(page)) actionFeedback = `${failure}：${error.message}`;
      } finally {
        busy = false; busyAction = ''; lastView = ''; await refresh();
      }
    }
    on(contact, 'click', () => act(currentView?.canView ? 'FLOAT_VIEW' : 'FLOAT_CONTACT'));
    on(undo, 'click', () => act('FLOAT_UNDO', '未撤销'));
    on(ball, 'click', event => {
      if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.detail !== 1) return;
      clearTimeout(ballTimer);
      ballTimer = setTimeout(() => {
        ballTimer = 0;
        if (currentView?.canView) act('FLOAT_VIEW');
        else { expanded(); refresh(); }
      }, 280);
    });
    on(ball, 'dblclick', event => {
      if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
      event.stopPropagation();
      clearTimeout(ballTimer); ballTimer = 0;
      open();
    });
    on(ball, 'keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    loadPosition();
    function receive(message, sender, respond) {
      if (disposed || sender.id !== runtime.id || message?.type !== 'FLOAT_COMPACT') return false;
      pinned = true; expanded(); refresh(); respond({ shown: true }); return false;
    }
    runtime.onMessage.addListener(receive);
    function dispose() {
      if (disposed) return;
      disposed = true; ++ticket;
      clearTimeout(ballTimer);
      clearTimeout(positionTimer);
      sound?.dispose();
      for (const remove of listeners) remove();
      try { runtime.onMessage.removeListener(receive); } catch { /* Old extension context. */ }
      host.remove();
    }
    return { refresh, dispose };
  };
})();
