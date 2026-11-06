import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { api, memoryStorage, company } from './helpers.js';
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function store() {
  const storage = memoryStorage(); const listeners = [];
  const local = { ...storage, async set(values) {
    await storage.set(values);
    for (const fn of listeners) fn(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'local');
  } };
  return { storage, repository: api.createPadRepository(local), changed: { addListener(fn) { listeners.push(fn); } } };
}
async function ui(shared, writer, options = {}) {
  const { document, window } = parseHTML(readFileSync(new URL('../extension/panel.html', import.meta.url), 'utf8'));
  const events = {};
  const sent = [];
  const chrome = { storage: { onChanged: shared.changed }, runtime: { async sendMessage(msg) {
    sent.push(msg);
    try {
      if (options.before) await options.before(msg);
      const result = msg.type === 'PAD_READ' ? { pad: await shared.repository.read() } : await shared.repository.save(msg);
      if (options.after) await options.after(msg, result);
      return { ok: true, ...result };
    } catch (error) { return { ok: false, error: error.message }; }
  } } };
  let viewport = 800;
  let resized;
  class Observer { constructor(callback) { resized = callback; } observe() {} }
  const controller = api.setupPad({ document, chrome, writer, onCopied: options.onCopied, clipboard: options.clipboard || { async writeText() {} }, viewport: () => viewport, listen(name, fn) { events[name] = fn; }, ResizeObserverClass: Observer });
  await controller.ready;
  const field = document.getElementById('pad-text');
  const emit = (node, type, values = {}) => {
    const event = new window.Event(type); Object.assign(event, values); node.dispatchEvent(event);
  };
  return { document, field, sent, events, emit,
    input(value) { field.value = value; emit(field, 'input'); },
    click(id) { const node = document.getElementById(id); assert.equal(node.disabled, false); node.click(); },
    status() { return document.getElementById('pad-status').textContent; },
    viewport(value) { viewport = value; events.resize(); },
    notifyResize() { resized(); }, nativeHeight(value) { field.style.height = `${value}px`; resized(); }
  };
}
test('pad is separate, validates stored data, serializes competing writers and rejects stale sequences', async () => {
  const shared = store(); shared.storage.data[api.PREFIX + company().key] = { ...company(), markedAt: '2026-10-11T00:00:00Z' };
  const initial = await shared.repository.read(); assert.equal(initial.text, '');
  const input = { text: '第一版', height: 160, revision: 0, writer: 'a', sequence: 1 };
  const [a, b] = await Promise.all([shared.repository.save(input), shared.repository.save({ ...input, writer: 'b' })]);
  assert.equal(a.conflict, false); assert.equal(b.conflict, true);
  const newer = await shared.repository.save({ ...input, text: '最新版', sequence: 3 });
  assert.equal(newer.conflict, false, 'same writer chain can save inputs already sent before first response');
  assert.equal((await shared.repository.save({ ...input, sequence: 2 })).conflict, true);
  const cleared = await shared.repository.save({ ...input, text: '', revision: newer.pad.revision, sequence: 4 });
  assert.equal(cleared.pad.text, '');
  assert.equal((await api.createRepository(shared.storage).list()).length, 1);
  assert.doesNotMatch(api.exportCsv(await api.createRepository(shared.storage).list()), /第一版|最新版|message-pad/);
  await assert.rejects(shared.repository.save({ ...input, height: 500 }), /无效/);
  shared.storage.data[api.PAD_KEY] = { text: '损坏数据', height: 100 };
  await assert.rejects(shared.repository.save(input), /格式异常/);
  assert.equal(shared.storage.data[api.PAD_KEY].text, '损坏数据');
});
test('latest input is sent immediately; delayed replies never replace newer text and reopening restores it', async () => {
  const shared = store(); const gate = deferred(); let first = true;
  const a = await ui(shared, 'a', { async after(msg) { if (msg.type === 'PAD_SAVE' && first) { first = false; await gate.promise; } } });
  a.input('短'); a.input('最后输入\n第二行');
  assert.equal(a.sent.filter(msg => msg.type === 'PAD_SAVE').length, 2, 'not waiting for panel-owned timers');
  a.events.pagehide(); await flush();
  assert.equal((await shared.repository.read()).text, '最后输入\n第二行');
  assert.equal(a.field.value, '最后输入\n第二行');
  gate.resolve(); await flush();
  assert.equal(a.field.value, '最后输入\n第二行');
  assert.equal(a.status(), '');
  assert.equal(a.document.getElementById('pad-status').parentElement.hidden, true);
  const reopened = await ui(shared, 'new-panel');
  assert.equal(reopened.field.value, '最后输入\n第二行');
  reopened.input(''); await flush();
  assert.equal((await shared.repository.read()).text, '');
  assert.equal(reopened.document.getElementById('pad-copy').disabled, true);
});
test('read/save failures preserve text, report failure and recover with explicit retry', async () => {
  const shared = store(); shared.storage.fail('get');
  const a = await ui(shared, 'a');
  assert.equal(a.field.disabled, true); assert.match(a.status(), /读取失败/);
  shared.storage.fail(null); a.click('pad-retry'); await flush();
  shared.storage.fail('set'); a.input('保存失败也不能丢'); await flush();
  assert.equal(a.field.value, '保存失败也不能丢'); assert.match(a.status(), /保存失败/);
  assert.equal(shared.storage.data[api.PAD_KEY], undefined);
  shared.storage.fail(null); a.click('pad-retry'); await flush();
  assert.equal(a.status(), ''); assert.equal((await shared.repository.read()).text, a.field.value);
});
test('two windows adopt clean changes but preserve unsaved text on conflict until explicit keep', async () => {
  const shared = store(); const gate = deferred(); let delay = false;
  const a = await ui(shared, 'a');
  const b = await ui(shared, 'b', { async before(msg) { if (delay && msg.type === 'PAD_SAVE') await gate.promise; } });
  a.input('共同初始话术'); await flush(); assert.equal(b.field.value, '共同初始话术');
  delay = true; b.input('B未保存的话术');
  a.input('A已保存的新话术'); await flush();
  assert.equal(b.field.value, 'B未保存的话术'); assert.match(b.status(), /另一窗口/);
  gate.resolve(); await flush();
  assert.equal((await shared.repository.read()).text, 'A已保存的新话术');
  assert.match(b.status(), /另一窗口/);
  b.click('pad-retry'); await flush();
  assert.equal((await shared.repository.read()).text, 'B未保存的话术');
  assert.equal(a.field.value, 'B未保存的话术'); assert.equal(b.status(), '');
});
test('copy uses latest unsaved input, gives success only after resolve and honest failure fallback', async () => {
  const shared = store(); const copyGate = deferred(); const copied = [];
  const a = await ui(shared, 'a', { clipboard: { writeText(text) { copied.push(text); return copyGate.promise; } } });
  shared.storage.fail('set'); a.input('最新尚未保存的文本'); a.click('pad-copy');
  assert.deepEqual(copied, ['最新尚未保存的文本']); assert.equal(a.document.getElementById('pad-copy-status').textContent, '正在复制…');
  a.input('复制期间又修改'); copyGate.resolve(); await flush();
  assert.match(a.document.getElementById('pad-copy-status').textContent, /点击时/);
  const failed = await ui(store(), 'f', { clipboard: { async writeText() { throw new Error('denied'); } } });
  failed.input('需要复制'); failed.click('pad-copy'); await flush();
  assert.match(failed.document.getElementById('pad-copy-status').textContent, /复制失败.*手动复制/);
  assert.doesNotMatch(failed.document.getElementById('pad-copy-status').textContent, /已复制/);
});
test('copy asks to collapse only after success and only while the copied text is still current', async () => {
  const shared = store(); const gate = deferred(); let collapsed = 0;
  const a = await ui(shared, 'a', { clipboard: { writeText() { return gate.promise; } }, onCopied() { collapsed++; } });
  a.input('点击时的话术'); a.click('pad-copy');
  assert.equal(collapsed, 0);
  gate.resolve(); await flush();
  assert.equal(collapsed, 1);
  const changed = deferred(); let changedCollapsed = 0;
  const b = await ui(shared, 'b', { clipboard: { writeText() { return changed.promise; } }, onCopied() { changedCollapsed++; } });
  b.input('复制中的文本'); b.click('pad-copy');
  b.input('复制期间又修改');
  changed.resolve(); await flush();
  assert.equal(changedCollapsed, 0);
  assert.match(b.document.getElementById('pad-copy-status').textContent, /点击时/);
  let failedCollapsed = 0;
  const failed = await ui(store(), 'c', { clipboard: { async writeText() { throw new Error('denied'); } }, onCopied() { failedCollapsed++; } });
  failed.input('需要复制'); failed.click('pad-copy'); await flush();
  assert.equal(failedCollapsed, 0);
  assert.match(failed.document.getElementById('pad-copy-status').textContent, /复制失败/);
  const broken = await ui(store(), 'd', { onCopied() { throw new Error('collapse unavailable'); } });
  broken.input('已经复制'); broken.click('pad-copy'); await flush();
  assert.match(broken.document.getElementById('pad-copy-status').textContent, /已复制；收起未完成/);
});
test('native resize persists user height, ignores restore/viewport notifications and leaves editing keys alone', async () => {
  const shared = store(); const a = await ui(shared, 'a'); a.input('保留话术'); await flush();
  assert.equal(Boolean(a.document.getElementById('pad-resize')), false);
  const before = a.sent.length; a.notifyResize(); await flush(); assert.equal(a.sent.length, before);
  a.nativeHeight(900);
  assert.equal(a.field.style.height, '480px');
  await flush();
  assert.equal((await shared.repository.read()).height, 480);
  const b = await ui(shared, 'b'); assert.equal(b.field.style.height, '480px');
  const restored = b.sent.length; b.notifyResize(); await flush(); assert.equal(b.sent.length, restored);
  b.viewport(400); b.notifyResize(); await flush(); assert.equal(b.field.style.height, '160px');
  assert.equal((await shared.repository.read()).height, 480, 'temporary viewport resize does not overwrite preferred height');
  assert.equal(b.sent.length, restored, 'viewport changes do not save or cause a write loop');
  const editingKey = new b.document.defaultView.Event('keydown', { cancelable: true });
  editingKey.key = 'ArrowUp'; b.field.dispatchEvent(editingKey); assert.equal(editingKey.defaultPrevented, false);
  b.nativeHeight(140); await flush(); assert.equal(b.field.style.height, '140px');
  const saved = b.sent.length; b.notifyResize(); b.notifyResize(); await flush(); assert.equal(b.sent.length, saved);
  b.viewport(800); assert.equal(b.field.style.height, '140px');
  b.nativeHeight(20); await flush(); assert.equal(b.field.style.height, '80px');
  assert.equal(b.field.value, '保留话术');
  assert.equal(api.padHeight(-200, 800), 80); assert.equal(api.padHeight(1000, 800), 480);
  const css = readFileSync(new URL('../extension/panel.css', import.meta.url), 'utf8');
  assert.match(css, /resize:\s*vertical/); assert.match(css, /max-width:\s*100%/);
});

test('older copy success cannot hide a newer failed copy; pending old save cannot hide remote conflict', async () => {
  const shared = store(); const oldCopy = deferred(); const oldSave = deferred(); let copied = 0; let pause = false;
  const a = await ui(shared, 'a', {
    clipboard: { writeText() { if (++copied === 1) return oldCopy.promise; return Promise.reject(new Error('denied')); } },
    async after(msg) { if (pause && msg.type === 'PAD_SAVE') await oldSave.promise; }
  });
  a.input('话术'); await flush(); a.click('pad-copy'); a.click('pad-copy'); await flush();
  assert.match(a.document.getElementById('pad-copy-status').textContent, /复制失败/);
  oldCopy.resolve(); await flush();
  assert.match(a.document.getElementById('pad-copy-status').textContent, /复制失败/);
  const b = await ui(shared, 'b');
  pause = true; a.input('A新输入'); await flush();
  b.input('B覆盖后'); await flush();
  assert.equal(a.field.value, 'A新输入'); assert.match(a.status(), /另一窗口/);
  oldSave.resolve(); await flush();
  assert.equal(a.field.value, 'A新输入'); assert.match(a.status(), /另一窗口/);
  assert.equal((await shared.repository.read()).text, 'B覆盖后');
});

test('failed old response preserves explicit remote conflict wording instead of generic retry overwrite', async () => {
  const shared = store(); const gate = deferred(); let delayFailure = false;
  const a = await ui(shared, 'a', { async after(msg) { if (delayFailure && msg.type === 'PAD_SAVE') { await gate.promise; throw new Error('late connection failure'); } } });
  a.input('开始内容'); await flush(); const b = await ui(shared, 'b');
  delayFailure = true; a.input('保留本地'); await flush(); b.input('远端新内容'); await flush();
  gate.resolve(); await flush();
  assert.equal(a.field.value, '保留本地'); assert.match(a.status(), /另一窗口/);
  assert.equal(a.document.getElementById('pad-retry').textContent, '保留我的内容');
  assert.equal((await shared.repository.read()).text, '远端新内容');
});
