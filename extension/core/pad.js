(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const PAD_KEY = 'settings:message-pad';
  const PAD_COLLAPSE_KEY = 'settings:pad-collapse-on-copy';
  function validPad(value) {
    if (!value || typeof value.text !== 'string' || !Number.isFinite(value.height) || value.height < 80 || value.height > 480 || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.writer !== 'string' || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return null;
    return { text: value.text, height: value.height, revision: value.revision, writer: value.writer, sequence: value.sequence };
  }
  function createPadRepository(storage) {
    let queue = Promise.resolve();
    async function read() {
      const value = (await storage.get(PAD_KEY))[PAD_KEY];
      if (value === undefined) return { text: '', height: 160, revision: 0, writer: '', sequence: 0 };
      const pad = validPad(value);
      if (!pad) throw new Error('话术数据格式异常，未覆盖原内容。请联系开发排查。');
      return pad;
    }
    function save(input) {
      const operation = queue.then(async () => {
        if (typeof input.text !== 'string' || !Number.isFinite(input.height) || input.height < 80 || input.height > 480 || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.writer !== 'string' || !input.writer || input.writer.length > 128 || !Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error('话术保存请求无效，请重试。');
        const current = await read();
        // Each input is dispatched immediately, so closing the panel does not leave
        // the latest keystrokes waiting in a panel-owned timer/queue.
        const sameWriter = current.writer === input.writer;
        if (input.revision > current.revision || (sameWriter && input.sequence <= current.sequence) || (current.revision !== input.revision && !sameWriter)) return { conflict: true, pad: current };
        const pad = { text: input.text, height: input.height, revision: current.revision + 1, writer: input.writer, sequence: input.sequence };
        await storage.set({ [PAD_KEY]: pad });
        return { conflict: false, pad };
      });
      queue = operation.catch(() => {});
      return operation;
    }
    return { read, save };
  }
  function padHeight(preferred, viewport = 800) {
    const maximum = Math.min(480, Math.max(80, Number(viewport) - 240));
    return Math.max(80, Math.min(maximum, Number(preferred) || 160));
  }
  Object.assign(api, { PAD_KEY, PAD_COLLAPSE_KEY, validPad, createPadRepository, padHeight });
})();
