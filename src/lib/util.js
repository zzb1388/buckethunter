(function () {
  const BH = (window.BH = window.BH || {});

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" +
      h.slice(6, 8).join("") + "-" + h.slice(8, 10).join("") + "-" + h.slice(10).join("");
  }

  function hash(str) {
    str = String(str || "");
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = 0x01000193 >>> 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function truncate(value, limit) {
    const s = value == null ? "" : String(value);
    return s.length > limit ? s.slice(0, limit) + "…" : s;
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = value;
    });
    return out;
  }

  async function pool(items, limit, fn) {
    const queue = items.slice();
    const size = Math.max(1, Math.min(limit || 1, queue.length || 1));
    const workers = [];
    for (let i = 0; i < size; i++) {
      workers.push((async function worker() {
        while (queue.length) {
          const item = queue.shift();
          try {
            await fn(item);
          } catch (err) {
            // 单个任务失败不影响整体扫描
          }
        }
      })());
    }
    await Promise.all(workers);
  }

  function uniq(list) {
    return Array.from(new Set(list));
  }

  function objectNameOk(name) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(String(name || ""));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return "0s";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m" + (s % 60) + "s";
  }

  BH.util = {
    uuid, hash, nowISO, sleep, truncate, headersToObject, pool, uniq,
    objectNameOk, escapeHtml, fmtDuration
  };
})();
