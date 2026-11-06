import '../extension/core/identity.js';
import '../extension/core/rest.js';
import '../extension/core/settings.js';
import '../extension/core/parser.js';
import '../extension/core/page-state.js';
import '../extension/core/records.js';
import '../extension/core/visits.js';
import '../extension/core/pad.js';
import '../extension/pad.js';
export const api = globalThis.BossTracker;
export const ID_A = '642056e116897a3b1HR-2924EVY~';
export const ID_B = 'ed38088b0f836f9e1Xd80t64EQ~~';
export const company = (id = ID_A, name = '示例公司') => ({ key: `boss:${id}`, url: `https://www.zhipin.com/gongsi/${id}.html`, name });
export function memoryStorage() {
  const data = {};
  let failure = null;
  return {
    data,
    fail(method) { failure = method; },
    async get(key) {
      if (failure === 'get') throw new Error('模拟读取失败');
      return structuredClone(key === null ? data : { [key]: data[key] });
    },
    async set(values) {
      if (failure === 'set') throw new Error('模拟保存失败');
      Object.assign(data, structuredClone(values));
    },
    async remove(key) {
      if (failure === 'remove') throw new Error('模拟撤销失败');
      delete data[key];
    }
  };
}
