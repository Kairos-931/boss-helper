import test from 'node:test';
import assert from 'node:assert/strict';
import { api, company, ID_B } from './helpers.js';
import '../extension/core/sound.js';

function audioMock(state = 'running') {
  const calls = { starts: 0, stops: 0, closes: 0, resumes: 0, buffers: [], sources: [] };
  let release = null, failure = null;
  const audio = {
    state, destination: {},
    createBuffer(channels, frames, rate) {
      const data = new Float32Array(frames);
      const buffer = { numberOfChannels: channels, length: frames, sampleRate: rate, getChannelData: () => data };
      calls.buffers.push(buffer); return buffer;
    },
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start() { if (failure === 'start') throw new Error('failed'); calls.starts++; }, stop() { calls.stops++; } };
      calls.sources.push(source); return source;
    },
    resume() {
      calls.resumes++;
      if (failure === 'resume') return Promise.reject(new Error('blocked'));
      return new Promise(resolve => { release = () => { audio.state = 'running'; resolve(); }; });
    },
    async close() { calls.closes++; audio.state = 'closed'; }
  };
  return { audio, calls, release: () => release?.(), fail(value) { failure = value; } };
}
function page(value = company(), token = 'a:1') {
  return { kind: 'detail', detailType: 'job', source: 'job-company-link', current: value, token, visitId: token };
}
function setup(state = 'running', shared = {}) {
  const mock = audioMock(state); let current = page(), visible = true;
  const states = [];
  const sound = api.createSound({ shared, current: () => current, visible: () => visible, audioFactory: () => mock.audio, onState: state => states.push(state) });
  return { ...mock, shared, sound, states,
    update(red = true, allowed = true, quiet = false) { sound.update({ red, quiet }, current, allowed); },
    page(next) { current = next; sound.observe(next); }, visible(value) { visible = value; }, current: () => current
  };
}

test('selected double tone matches 660Hz then 880Hz, half-second length, soft envelope and silent gap', () => {
  const { audio } = audioMock(); const buffer = api.doubleTone(audio), samples = buffer.getChannelData(0);
  assert.equal(buffer.numberOfChannels, 1); assert.equal(buffer.length, 24255); assert.equal(buffer.sampleRate, 44100);
  assert.ok(Math.max(...samples.map(Math.abs)) < 0.17);
  for (const index of [0, 7600, 8000, 20000, 24254]) assert.equal(samples[index], 0);
  for (const [time, start, length, frequency] of [[.08, 0, .16, 660], [.28, .19, .22, 880]]) {
    const index = Math.round(time * 44100), x = index / 44100 - start;
    const expected = .17 * Math.min(1, x / .012) * Math.min(1, (length - x) / .04) * Math.exp(-2.4 * x / length) * Math.sin(2 * Math.PI * frequency * x);
    assert.ok(Math.abs(samples[index] - expected) < 1e-7);
  }
});

test('one red encounter plays once across redraws, token changes, unknown flashes and communication updates', () => {
  const h = setup(); h.update();
  assert.equal(h.calls.starts, 1);
  h.update(); h.page(page(company(), 'a:2')); h.update();
  h.page({ kind: 'unknown', current: null, token: 'unknown' }); h.update(false);
  h.page(page(company(), 'a:3')); h.update(); h.update(false); h.update();
  assert.equal(h.calls.starts, 1);
  h.sound.dispose(); assert.equal(h.calls.closes, 1);
});
test('a newly added company stays quiet even when its ball is red', () => {
  const h = setup(); h.update(true, true, true); assert.equal(h.calls.starts, 0);
  h.update(true, true, false); assert.equal(h.calls.starts, 0, 'quiet red alert is consumed for this encounter');
  h.page(page(company(ID_B), 'b:1')); h.update(true, true, false); assert.equal(h.calls.starts, 1);
  h.sound.dispose();
});

test('different company or explicit return to list begins next encounter; first neutral visit never sounds', () => {
  const h = setup(); h.update(false); assert.equal(h.calls.starts, 0);
  h.update(); assert.equal(h.calls.starts, 1);
  h.page(page(company(ID_B), 'b:1')); h.update(); assert.equal(h.calls.starts, 2);
  h.page(page(company(), 'a:2')); h.update(); assert.equal(h.calls.starts, 3);
  h.page({ kind: 'list', current: null, token: 'list' }); h.update(false);
  h.page(page(company(), 'a:3')); h.update(); assert.equal(h.calls.starts, 4);
  h.sound.dispose();
});

test('query, suppressed company, hidden document and unfocused window cannot play or consume pending alert', () => {
  const h = setup();
  h.visible(false); h.update(); assert.equal(h.calls.starts, 0);
  h.visible(true); h.update(true, false); assert.equal(h.calls.starts, 0);
  h.page({ kind: 'query', nameHint: '示例公司', current: null, token: 'q' }); h.update(); assert.equal(h.calls.starts, 0);
  h.page({ ...page(), detailType: 'company', source: 'company-page', history: { state: 'suppressed' } }); h.update(); assert.equal(h.calls.starts, 0);
  h.page(page()); h.update(); assert.equal(h.calls.starts, 1); h.sound.dispose();
});

test('suspended context never pretends to play and explicit unlock resumes in its call before promise completion', async () => {
  const h = setup('suspended'); h.update(); h.update();
  assert.equal(h.calls.starts, 0); assert.equal(h.calls.resumes, 0); assert.equal(h.sound.state().blocked, true);
  const unlocked = h.sound.unlock(); assert.equal(h.calls.resumes, 1);
  h.release(); await unlocked;
  assert.equal(h.calls.starts, 1); assert.equal(h.sound.state().blocked, false);
  h.update(); assert.equal(h.calls.starts, 1); h.sound.dispose();
});

test('late resume cannot play the preceding company after switching, hiding, muting or disposing', async () => {
  for (const change of ['switch', 'hide', 'mute', 'dispose']) {
    const h = setup('suspended'); h.update(); const unlocked = h.sound.unlock();
    if (change === 'switch') h.page(page(company(ID_B), 'b:1'));
    if (change === 'hide') h.visible(false);
    if (change === 'mute') h.sound.setEnabled(false);
    if (change === 'dispose') h.sound.dispose();
    h.release(); await unlocked; assert.equal(h.calls.starts, 0, change);
    h.sound.dispose();
  }
});

test('rejected unlock and failed start remain retryable without claiming delivery', async () => {
  const h = setup('suspended'); h.update(); h.fail('resume'); await h.sound.unlock();
  assert.equal(h.sound.state().failed, true); assert.equal(h.calls.starts, 0);
  h.fail(null); const unlocked = h.sound.unlock(); h.release(); await unlocked;
  assert.equal(h.calls.starts, 1); h.sound.dispose();
  const other = setup(); other.fail('start'); other.update();
  assert.equal(other.calls.starts, 0); assert.equal(other.sound.state().failed, true);
  other.fail(null); other.update(); assert.equal(other.calls.starts, 1); other.sound.dispose();
});

test('mute stops current source and does not replay same encounter after unmute; recovery retains deduplication', () => {
  const shared = {}; const h = setup('running', shared); h.update();
  h.sound.setEnabled(false); assert.equal(h.calls.stops, 1);
  h.sound.setEnabled(true); h.update(); assert.equal(h.calls.starts, 1); h.sound.dispose();
  const restored = setup('running', shared); restored.update(); assert.equal(restored.calls.starts, 0);
  restored.page(page(company(ID_B), 'b:1')); restored.update(); assert.equal(restored.calls.starts, 1); restored.sound.dispose();
});
