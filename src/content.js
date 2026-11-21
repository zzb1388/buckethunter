(function () {
  if (window.__bucketHunterLoaded) return;
  window.__bucketHunterLoaded = true;

  const MAX_URLS = 3000;
  const MAX_INLINE_CHARS = 200000;
  const MAX_INLINE_SCRIPTS = 50;

  function absolute(value) {
    if (!value) return "";
    try {
      return new URL(value, location.href).href;
    } catch (e) {
      return "";
    }
  }

  function push(set, value) {
    if (!value) return;
    const v = String(value).trim();
    if (!v || v.length > 2048) return;
    if (/^(javascript|data|blob|mailto|tel):/i.test(v)) return;
    if (set.size < MAX_URLS) set.add(v);
  }

  function collect() {
    const jsUrls = new Set();
    const domUrls = new Set();
    const resourceUrls = new Set();
    const inlineScripts = [];

    document.querySelectorAll("script[src]").forEach(function (el) {
      push(jsUrls, absolute(el.getAttribute("src")));
      push(jsUrls, el.src);
    });

    document.querySelectorAll('link[rel~="preload"][as="script"], link[rel="modulepreload"], link[rel="preload"][as="worker"]').forEach(function (el) {
      push(jsUrls, absolute(el.getAttribute("href")));
    });

    document.querySelectorAll("script:not([src])").forEach(function (el) {
      const text = el.textContent || "";
      if (text.trim() && inlineScripts.length < MAX_INLINE_SCRIPTS) {
        inlineScripts.push(text.length > MAX_INLINE_CHARS ? text.slice(0, MAX_INLINE_CHARS) : text);
      }
    });

    document.querySelectorAll("img, source, video, audio, iframe, embed, object, link, a, track").forEach(function (el) {
      ["src", "data-src", "href", "data", "poster"].forEach(function (attr) {
        if (el.getAttribute) push(domUrls, absolute(el.getAttribute(attr)));
      });
    });

    document.querySelectorAll("[srcset]").forEach(function (el) {
      const srcset = el.getAttribute("srcset") || "";
      srcset.split(",").forEach(function (part) {
        const url = part.trim().split(/\s+/)[0];
        push(domUrls, absolute(url));
      });
    });

    try {
      performance.getEntriesByType("resource").forEach(function (entry) {
        push(resourceUrls, entry.name);
        if (entry.initiatorType === "script" || /\.m?js(\?|#|$)/i.test(entry.name)) {
          push(jsUrls, entry.name);
        }
      });
    } catch (e) { /* ignore */ }

    // 内联脚本里出现的完整 URL 也直接作为候选
    inlineScripts.forEach(function (text) {
      const re = /(?:https?:)?\/\/[^\s"'`<>()\\]+/gi;
      let m;
      while ((m = re.exec(text))) {
        const raw = m[0].startsWith("//") ? "https:" + m[0] : m[0];
        push(domUrls, raw);
        if (domUrls.size >= MAX_URLS) break;
      }
    });

    return {
      url: location.href,
      title: document.title || "",
      jsUrls: Array.from(jsUrls),
      domUrls: Array.from(domUrls),
      resourceUrls: Array.from(resourceUrls),
      inlineScripts: inlineScripts,
      at: Date.now()
    };
  }

  function sendHarvest() {
    const data = collect();
    try {
      browser.runtime.sendMessage({ type: "bh.harvest", data: data }).catch(function () {});
    } catch (e) { /* 扩展重载时忽略 */ }
  }

  browser.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "bh.requestHarvest") {
      sendHarvest();
    }
  });

  sendHarvest();
  setTimeout(sendHarvest, 1500);
  setTimeout(sendHarvest, 5000);
  window.addEventListener("load", function () {
    setTimeout(sendHarvest, 800);
  });

  // SPA 路由变化后再采集一次
  let lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(sendHarvest, 1200);
    }
  }, 2000);
})();
