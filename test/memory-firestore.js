function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * In-memory stand-in for the Firestore calls the wallet store makes.
 * Transactions run one at a time. Real contention is covered by
 * test/firestore-emulator.test.js when FIRESTORE_EMULATOR_HOST is set.
 */
export function createMemoryFirestore() {
  const docs = new Map();
  let tail = Promise.resolve();

  function queryMap(source, collection, field, op, value) {
    const prefix = `${collection}/`;
    const rows = [];
    for (const [path, data] of source) {
      if (!path.startsWith(prefix)) continue;
      const id = path.slice(prefix.length);
      if (!id || id.includes('/')) continue;
      if (field) {
        const current = data[field];
        if (op === '==' && current !== value) continue;
        if (op === '<' && !(current < value)) continue;
      }
      rows.push({ id, ...clone(data) });
    }
    return rows;
  }

  function runTransaction(fn) {
    const job = tail.then(async () => {
      const pendingSets = new Map();
      const pendingDeletes = new Set();
      let writing = false;
      const tx = {
        async get(path) {
          if (writing) throw new Error('firestore read after write');
          if (pendingDeletes.has(path)) return null;
          if (pendingSets.has(path)) return clone(pendingSets.get(path));
          const current = docs.get(path);
          return current ? clone(current) : null;
        },
        set(path, data) {
          writing = true;
          pendingDeletes.delete(path);
          pendingSets.set(path, clone(data));
        },
        delete(path) {
          writing = true;
          pendingSets.delete(path);
          pendingDeletes.add(path);
        },
      };
      const result = await fn(tx);
      for (const [path, data] of pendingSets) docs.set(path, data);
      for (const path of pendingDeletes) docs.delete(path);
      return result;
    });
    tail = job.then(() => {}, () => {});
    return job;
  }

  return {
    runTransaction,
    query: (collection, field, op, value) => Promise.resolve(queryMap(docs, collection, field, op, value)),
    async get(path) {
      const current = docs.get(path);
      return current ? clone(current) : null;
    },
    set(path, data) {
      docs.set(path, clone(data));
    },
  };
}
