(() => {
  'use strict';
  const api = globalThis.BossTracker;
  const VISIT_PREFIX = 'current-visit:';
  function createVisits(repository, session) {
    let queue = Promise.resolve();
    const serial = task => {
      const result = queue.then(task);
      queue = result.catch(() => {});
      return result;
    };
    function open(tabId, snapshot, verify) {
      return serial(async () => {
        await verify();
        const storageKey = VISIT_PREFIX + tabId;
        const saved = (await session.get(storageKey))[storageKey];
        if (saved?.visitId === snapshot.visitId && saved.key === snapshot.current.key) {
          await repository.correctName(snapshot.current, verify);
          return saved;
        }
        const result = await repository.visit(snapshot.current, verify);
        const history = { visitId: snapshot.visitId, key: snapshot.current.key, state: result.existed ? 'prior' : 'first', markedAt: result.record.markedAt, documentId: snapshot.documentId, href: snapshot.href };
        await session.set({ [storageKey]: history });
        return history;
      });
    }
    function remove(key) {
      return serial(async () => {
        const sessions = await session.get(null);
        const updates = {};
        const affected = [];
        for (const [storageKey, history] of Object.entries(sessions)) {
          if (!storageKey.startsWith(VISIT_PREFIX) || history.key !== key) continue;
          const value = { ...history, state: 'suppressed' };
          updates[storageKey] = value;
          affected.push({ tabId: Number(storageKey.slice(VISIT_PREFIX.length)), history: value });
        }
        // Persist suppression first: a failed deletion may show a recoverable error,
        // but a successful deletion must never be immediately recreated by this visit.
        if (affected.length) await session.set(updates);
        try { await repository.remove(key); }
        catch (error) { if (affected.length) await session.set(Object.fromEntries(Object.keys(updates).map(name => [name, sessions[name]]))); throw error; }
        return affected;
      });
    }
    function manual(tabId, snapshot, verify) {
      return serial(async () => {
        await verify();
        const storageKey = VISIT_PREFIX + tabId;
        const saved = (await session.get(storageKey))[storageKey];
        if (saved?.visitId === snapshot.visitId && saved.key === snapshot.current.key && saved.state === 'manual') {
          await repository.correctName(snapshot.current, verify);
          return saved;
        }
        const result = await repository.visit(snapshot.current, verify);
        const history = { visitId: snapshot.visitId, key: snapshot.current.key, state: result.existed ? 'prior' : 'manual', markedAt: result.record.markedAt, documentId: snapshot.documentId, href: snapshot.href };
        await session.set({ [storageKey]: history });
        return history;
      });
    }
    return { open, manual, remove, recover: serial };
  }
  Object.assign(api, { createVisits, VISIT_PREFIX });
})();
