// 端末内保存(IndexedDB)。サーバーへは一切送信しない。
const NAME = "receipt-local", VER = 1;
let _db;
function open() {
  return _db || (_db = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("customers", { keyPath: "id", autoIncrement: true }); d.createObjectStore("meta"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
const tx = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const out = fn(t.objectStore(store)); t.oncomplete = () => res(out && "result" in out ? out.result : undefined); t.onerror = t.onabort = () => rej(t.error); }); };
export const all = () => tx("customers", "readonly", (s) => s.getAll());
export const put = (c) => { const { _t, ...clean } = c; return tx("customers", "readwrite", (s) => s.put(clean)); };
export const putMany = async (list) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction("customers", "readwrite"), s = t.objectStore("customers"); list.forEach((c) => { const { _t, ...x } = c; s.put(x); }); t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); }); };
export const clearAll = () => tx("customers", "readwrite", (s) => s.clear());
export const getMeta = (k) => tx("meta", "readonly", (s) => s.get(k));
export const setMeta = (k, v) => tx("meta", "readwrite", (s) => s.put(v, k));
