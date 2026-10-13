/* Persistence: owner profile (PIN), settings, chat history. */
const KEY = "sso_";

export const local = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(KEY + k);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* quota full */ } },
  del(k) { try { localStorage.removeItem(KEY + k); } catch {} },
  clearAll() {
    Object.keys(localStorage).filter((k) => k.startsWith(KEY)).forEach((k) => localStorage.removeItem(k));
  },
};

/* Tiny non-reversible hash for the PIN (enough to gate a phone app; not security-critical data). */
export function hashPin(pin) {
  let h = 5381;
  const s = "sso:" + pin;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
