(function () {
  const BH = window.BH;
  const U = BH.util;
  const P = BH.patterns;
  const PR = BH.probe;

  const DEFAULT_SETTINGS = {
    timeoutMs: 12000,
    concurrency: 4,
    maxJsFiles: 300,
    maxJsBytes: 4 * 1024 * 1024,
    maxTargets: 300,
    autoWrite: false,
    resolveCname: true,
    cnameMax: 40,
    crawlChunks: true,
    chunkLimit: 300,
    autoScan: true
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let findings = {};
  let job = { running: false, phase: "idle", done: 0, total: 0, targets: 0 };
  const tabHarvest = new Map();
  let saveTimer = null;
  const autoState = new Map();
  const autoTimers = new Map();
  const AUTO_COOLDOWN_MS = 24 * 60 * 60 * 1000;

  function emit(event) {
    try {
      browser.runtime.sendMessage({ type: "bh.event", evt: event }).catch(function () {});
    } catch (e) { /* 弹窗关闭时忽略 */ }
  }

  function emitJob() {
    emit({ kind: "job", job: job });
  }

  function emitFindings(items) {
    emit({ kind: "findings", items: items });
  }

  function loadState() {
    browser.storage.local.get(["findings", "settings", "autoHistory"]).then(function (stored) {
      if (stored && stored.settings) settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings);
      if (stored && stored.findings && typeof stored.findings === "object") findings = stored.findings;
      if (stored && stored.autoHistory && typeof stored.autoHistory === "object") {
        const cutoff = Date.now() - AUTO_COOLDOWN_MS;
        Object.keys(stored.autoHistory).forEach(function (key) {
          const at = stored.autoHistory[key];
          if (typeof at === "number" && at > cutoff) autoState.set(key, at);
        });
      }
    }).catch(function () {});
  }
  loadState();

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      const keys = Object.keys(findings);
      if (keys.length > 3000) {
        keys.sort(function (a, b) {
          return (findings[a].lastSeen || 0) - (findings[b].lastSeen || 0);
        });
        keys.slice(0, keys.length - 3000).forEach(function (k) { delete findings[k]; });
      }
      const autoHistory = {};
      const cutoff = Date.now() - AUTO_COOLDOWN_MS;
      autoState.forEach(function (at, key) {
        if (at > cutoff) autoHistory[key] = at;
        else autoState.delete(key);
      });
      browser.storage.local.set({
        findings: findings, settings: settings, autoHistory: autoHistory
      }).catch(function () {});
    }, 800);
  }

  function mergeHarvest(tabId, frameId, data) {
    if (!data) return;
    let entry = tabHarvest.get(tabId);
    if (!entry) {
      entry = { frames: new Map(), updated: 0 };
      tabHarvest.set(tabId, entry);
    }
    entry.frames.set(frameId || 0, {
      url: data.url || "",
      title: data.title || "",
      jsUrls: (data.jsUrls || []).slice(0, 3000),
      domUrls: (data.domUrls || []).slice(0, 3000),
      resourceUrls: (data.resourceUrls || []).slice(0, 3000),
      inlineScripts: (data.inlineScripts || []).slice(0, 50),
      receivedAt: Date.now()
    });
    entry.updated = Date.now();
  }

  function upsertFinding(target, detection, refs, pageUrl) {
    const id = U.hash(target.key);
    const now = Date.now();
    let finding = findings[id];
    if (!finding) {
      finding = findings[id] = {
        id: id,
        target: target,
        refs: [],
        detections: [],
        write: null,
        firstSeen: now,
        lastSeen: now,
        pageUrl: pageUrl || ""
      };
    }
    finding.lastSeen = now;
    if (pageUrl) finding.pageUrl = pageUrl;
    finding.target = target;
    finding.detection = detection;
    finding.detections = (finding.detections || []).concat([{
      at: detection.checkedAt,
      status: detection.status,
      httpStatus: detection.httpStatus
    }]).slice(-20);

    if (refs && refs.length) {
      const seen = new Set(finding.refs.map(function (r) { return r.id; }));
      refs.forEach(function (r) {
        if (!seen.has(r.id) && finding.refs.length < 20) {
          seen.add(r.id);
          finding.refs.push(r);
        }
      });
    }
    scheduleSave();
    return finding;
  }

  function findSourceMapUrl(jsText, jsUrl) {
    const matches = jsText.match(/[#@]\s*sourceMappingURL=([^\s'"*]+)/g);
    if (!matches || !matches.length) return "";
    const last = matches[matches.length - 1];
    const raw = last.replace(/^[#@]\s*sourceMappingURL=/, "").trim();
    if (!raw || /^data:/i.test(raw)) return "";
    try {
      return new URL(raw, jsUrl).href;
    } catch (e) {
      return "";
    }
  }

  function collectJsUrls(harvest) {
    const set = new Set();
    harvest.frames.forEach(function (frame) {
      (frame.jsUrls || []).forEach(function (u) {
        if (/^https?:/i.test(u)) set.add(u);
      });
      (frame.resourceUrls || []).forEach(function (u) {
        if (/^https?:/i.test(u) && /\.m?js(\?|#|$)/i.test(u)) set.add(u);
      });
      (frame.domUrls || []).forEach(function (u) {
        if (/^https?:/i.test(u) && /\.m?js(\?|#|$)/i.test(u)) set.add(u);
      });
      (frame.inlineScripts || []).forEach(function (text) {
        const re = /(?:https?:)?\/\/[^\s"'`<>()\\]+?\.m?js(?:\?[^\s"'`<>()\\]*)?/gi;
        let m;
        while ((m = re.exec(text))) {
          const raw = m[0].startsWith("//") ? "https:" + m[0] : m[0];
          if (/^https?:/i.test(raw)) set.add(raw);
        }
      });
    });
    return Array.from(set);
  }

  const SKIP_CNAME_HOSTS = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|gstatic\.com|googleapis\.com|google\.com|facebook\.com|facebook\.net|baidu\.com|bdstatic\.com|cnzz\.com|umeng\.com|umengcloud\.com|w3\.org|schema\.org|sentry\.io|sentry-cdn\.com)$/i;

  async function fetchPageFallback(pageUrl) {
    if (!pageUrl) return null;
    const res = await PR.fetchSafe(pageUrl, { timeout: settings.timeoutMs, maxBody: 2 * 1024 * 1024 });
    if (!res.ok || res.status < 200 || res.status >= 300) return null;
    const jsUrls = [];
    const re = /<script[^>]+src=["']([^"']+)["']/gi;
    let m;
    let guard = 0;
    while ((m = re.exec(res.body)) && guard++ < 500) {
      try { jsUrls.push(new URL(m[1], pageUrl).href); } catch (e) { /* ignore */ }
    }
    return {
      url: pageUrl,
      title: "",
      jsUrls: jsUrls.slice(0, 200),
      domUrls: [],
      resourceUrls: [],
      inlineScripts: [res.body.slice(0, 400000)],
      fallback: true
    };
  }

  // 识别 webpack 懒加载 chunk 模板:o.p+"static/js/"+e+".js"
  function findChunkTemplates(text, pageUrl) {
    const out = new Set();
    if (!text) return out;
    const re = /(["'])([^"']{1,200}?)\1\s*\+\s*[A-Za-z_$][\w$]*\s*\+\s*(["'])\.js\3/g;
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 60) {
      const prefix = m[2];
      if (!/chunk|js\//i.test(prefix)) continue;
      try {
        out.add(new URL(prefix, pageUrl).href.replace(/\/?$/, "/"));
      } catch (e) { /* ignore */ }
    }
    return out;
  }

  // 显式 chunk 依赖:id 出现在 .e(123) 调用里
  function findChunkIds(text, set) {
    if (!text) return;
    const re = /\.e\(\s*["']?(\d{1,5})["']?\s*\)/g;
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 3000) set.add(parseInt(m[1], 10));
  }

  async function runScan(tabId, pageUrl) {
    if (job.running) return { ok: false, error: "已有扫描进行中" };

    const stored = tabHarvest.get(tabId);
    const stats = {
      frames: 0, pageFallback: false, jsTotal: 0, jsOk: 0, jsFail: 0,
      hosts: 0, candidates: 0, chunkTried: 0, chunksFetched: 0,
      cnameChecked: 0, cnameAnswers: 0, cnameBuckets: 0, cnameErrors: 0
    };

    job = {
      running: true, cancelled: false, phase: "collect",
      done: 0, total: 0, targets: 0, stats: stats,
      startedAt: Date.now(), tabId: tabId
    };
    emitJob();

    try {
      const frames = new Map();
      if (stored && stored.frames.size) {
        stored.frames.forEach(function (value, key) { frames.set(key, value); });
      } else {
        const fallbackFrame = await fetchPageFallback(pageUrl);
        if (fallbackFrame) {
          frames.set(0, fallbackFrame);
          stats.pageFallback = true;
        }
      }
      stats.frames = frames.size;
      if (!frames.size) {
        job.phase = "error";
        job.error = "未采集到页面数据(内容脚本不可用且 HTML 抓取失败)";
        return { ok: false, error: job.error, stats: stats };
      }

      const basePage = pageUrl || ((frames.values().next().value || {}).url) || "";
      const chunkTemplates = new Set();
      const discoveredChunkIds = new Set();
      const noteChunkMeta = function (text) {
        findChunkTemplates(text, basePage).forEach(function (t) { chunkTemplates.add(t); });
        findChunkIds(text, discoveredChunkIds);
      };

      const sink = new Map();
      const hostCounts = new Map();
      const bumpHost = function (host) {
        if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
      };
      const addBlob = function (ref, text) {
        if (!text) return;
        P.extract(text, ref, sink);
        P.extractHosts(text, hostCounts, 800);
      };
      const addUrlHost = function (raw) {
        const h = P.hostFromUrl(raw);
        if (h) bumpHost(h);
      };

      frames.forEach(function (frame) {
        addBlob(frame.url || "", frame.url);
        if (frame.url) addUrlHost(frame.url);
        (frame.inlineScripts || []).forEach(function (text) {
          addBlob((frame.url || "") + " [inline]", text);
        });
        (frame.domUrls || []).forEach(function (u) { addBlob(frame.url || "", u); addUrlHost(u); });
        (frame.resourceUrls || []).forEach(function (u) { addBlob(frame.url || "", u); addUrlHost(u); });
        (frame.jsUrls || []).forEach(function (u) { addBlob(frame.url || "", u); addUrlHost(u); });
      });
      stats.hosts = hostCounts.size;
      stats.candidates = sink.size;
      console.log("[BucketHunter] 采集完成", {
        frames: stats.frames, hosts: stats.hosts, candidates: stats.candidates, pageFallback: stats.pageFallback
      });

      const jsList = collectJsUrls({ frames: frames }).slice(0, Math.max(0, settings.maxJsFiles));
      job.phase = "collect";
      job.total = jsList.length;
      job.done = 0;
      stats.jsTotal = jsList.length;
      emitJob();

      let jsDone = 0;
      await U.pool(jsList, 4, async function (jsUrl) {
        if (job.cancelled) return;
        const res = await PR.fetchSafe(jsUrl, { maxBody: settings.maxJsBytes, timeout: settings.timeoutMs });
        if (res.ok && res.status >= 200 && res.status < 300) {
          stats.jsOk++;
          addBlob(jsUrl, res.body);
          noteChunkMeta(res.body);
          const mapUrl = findSourceMapUrl(res.body, jsUrl);
          if (mapUrl) {
            const mapRes = await PR.fetchSafe(mapUrl, {
              maxBody: Math.min(settings.maxJsBytes * 2, 16 * 1024 * 1024),
              timeout: settings.timeoutMs
            });
            if (mapRes.ok && mapRes.status >= 200 && mapRes.status < 300) addBlob(mapUrl, mapRes.body);
          }
        } else {
          stats.jsFail++;
        }
        job.done = ++jsDone;
        emitJob();
      });

      if (job.cancelled) {
        job.phase = "cancelled";
        return { ok: true, cancelled: true, stats: stats };
      }

      // 懒加载 chunk 阶段:桶地址经常只存在于未加载的路由 chunk 里
      if (settings.crawlChunks !== false && chunkTemplates.size && settings.chunkLimit > 0) {
        const templates = Array.from(chunkTemplates).slice(0, 2);
        const fetchedIds = new Set();
        const idSet = new Set();
        for (let i = 0; i < settings.chunkLimit; i++) idSet.add(i);
        discoveredChunkIds.forEach(function (id) { if (isFinite(id) && id >= 0) idSet.add(id); });
        const ordered = Array.from(idSet).sort(function (a, b) { return a - b; });

        // chunk 预算独立于 JS 文件上限,避免旧配置 maxJsFiles 较小导致提前截断
        let budget = Math.max(0, settings.chunkLimit);
        job.phase = "chunks";
        job.total = Math.min(ordered.length, budget);
        job.done = 0;
        emitJob();
        console.log("[BucketHunter] chunk 模板", templates);

        let missStreak = 0;
        let hitCount = 0;
        const BATCH = 8;
        for (let start = 0; start < ordered.length && budget > 0 && missStreak < 16; start += BATCH) {
          if (job.cancelled) break;
          const batch = ordered.slice(start, start + BATCH).filter(function (id) { return !fetchedIds.has(id); });
          let batchHits = 0;
          await U.pool(batch, 4, async function (id) {
            if (job.cancelled || budget <= 0) return;
            fetchedIds.add(id);
            budget--;
            stats.chunkTried++;
            for (let i = 0; i < templates.length; i++) {
              const chunkUrl = templates[i] + id + ".js";
              const res = await PR.fetchSafe(chunkUrl, { maxBody: settings.maxJsBytes, timeout: settings.timeoutMs });
              if (!res.ok || res.status !== 200) continue;
              const contentType = String(res.headers["content-type"] || "").toLowerCase();
              if (contentType.indexOf("html") !== -1) continue;
              if (/^\s*<(!doctype|html)/i.test(res.body)) continue;
              batchHits++;
              stats.chunksFetched++;
              addBlob(chunkUrl, res.body);
              noteChunkMeta(res.body);
              break;
            }
            job.done++;
            emitJob();
          });
          hitCount += batchHits;
          missStreak = batchHits > 0 ? 0 : missStreak + batch.length;
          if (hitCount === 0 && fetchedIds.size >= Math.min(settings.chunkLimit, 80)) break;
        }
        stats.candidates = sink.size;
        console.log("[BucketHunter] 懒加载 chunk", {
          tried: stats.chunkTried, fetched: stats.chunksFetched, candidates: stats.candidates
        });
      }

      // CNAME 阶段:自定义 CDN 域名 → 真实桶
      if (settings.resolveCname !== false && settings.cnameMax > 0) {
        const toResolve = [];
        Array.from(hostCounts.entries())
          .sort(function (a, b) { return b[1] - a[1]; })
          .forEach(function (pair) {
            if (toResolve.length >= settings.cnameMax) return;
            const host = pair[0];
            if (SKIP_CNAME_HOSTS.test(host)) return;
            const existing = P.classifyUrl("https://" + host + "/");
            if (existing && existing.bucket) return;
            toResolve.push(host);
          });

        job.phase = "cname";
        job.total = toResolve.length;
        job.done = 0;
        emitJob();

        let cnameDone = 0;
        await U.pool(toResolve, 4, async function (host) {
          if (job.cancelled) return;
          const answer = await PR.resolveCname(host);
          stats.cnameChecked++;
          if (answer.error) stats.cnameErrors++;
          if (answer.answers && answer.answers.length) stats.cnameAnswers++;
          (answer.answers || []).forEach(function (cnameTarget) {
            const target = P.classifyUrl("https://" + cnameTarget + "/");
            if (!target || !target.bucket) return;
            stats.cnameBuckets++;
            target.cnameFrom = host;
            P.addTarget(sink, target, "CNAME " + host, "https://" + cnameTarget + "/");
          });
          job.done = ++cnameDone;
          emitJob();
        });
        stats.candidates = sink.size;
        console.log("[BucketHunter] CNAME 解析", {
          checked: stats.cnameChecked, answers: stats.cnameAnswers,
          bucketHits: stats.cnameBuckets, errors: stats.cnameErrors, candidates: stats.candidates
        });
      }

      const entries = Array.from(sink.values())
        .sort(function (a, b) { return b.refs.length - a.refs.length; })
        .slice(0, Math.max(0, settings.maxTargets));

      job.phase = "probe";
      job.total = entries.length;
      job.targets = entries.length;
      job.done = 0;
      emitJob();

      const fallbackPage = pageUrl || (frames.values().next().value || {}).url || "";
      let probeDone = 0;

      await U.pool(entries, Math.max(1, settings.concurrency), async function (entry) {
        if (job.cancelled) return;
        const target = entry.target;
        const detection = await PR.probeTarget(target);

        if (detection.region && !target.region) target.region = detection.region;
        if (detection.providerHint && target.provider === "自定义/CDN") target.provider = detection.providerHint;

        const finding = upsertFinding(target, detection, entry.refs, fallbackPage);
        emitFindings([finding]);

        if (settings.autoWrite && detection.status === "PUBLIC_LIST") {
          const writeResult = await PR.writeProbe(target);
          finding.write = writeResult;
          finding.lastSeen = Date.now();
          scheduleSave();
          emitFindings([finding]);
        }

        job.done = ++probeDone;
        emitJob();
      });

      job.phase = "done";
      console.log("[BucketHunter] 扫描完成", { targets: entries.length, stats: stats });
      return { ok: true, targetCount: entries.length, stats: stats };
    } catch (err) {
      job.phase = "error";
      job.error = String((err && err.message) || err);
      console.error("[BucketHunter] 扫描异常", err);
      return { ok: false, error: job.error, stats: stats };
    } finally {
      job.running = false;
      job.finishedAt = Date.now();
      emitJob();
      scheduleSave();
    }
  }

  async function runWrite(findingId) {
    const finding = findings[findingId];
    if (!finding) return { ok: false, error: "记录不存在" };
    const result = await PR.writeProbe(finding.target);
    finding.write = result;
    finding.lastSeen = Date.now();
    scheduleSave();
    emitFindings([finding]);
    return { ok: true, write: result };
  }

  async function runRecheck(findingId) {
    const finding = findings[findingId];
    if (!finding) return { ok: false, error: "记录不存在" };
    const detection = await PR.probeTarget(finding.target);
    if (detection.region && !finding.target.region) finding.target.region = detection.region;
    if (detection.providerHint && finding.target.provider === "自定义/CDN") finding.target.provider = detection.providerHint;
    finding.detection = detection;
    finding.detections = (finding.detections || []).concat([{
      at: detection.checkedAt, status: detection.status, httpStatus: detection.httpStatus
    }]).slice(-20);
    finding.lastSeen = Date.now();
    scheduleSave();
    emitFindings([finding]);
    return { ok: true, detection: detection };
  }

  async function probeManual(rawUrl, tabId) {
    let target = P.classifyUrl(rawUrl);
    if (!target) target = P.makeGenericTarget(rawUrl);
    if (!target) return { ok: false, error: "无法解析目标地址" };
    const detection = await PR.probeTarget(target);
    if (detection.region && !target.region) target.region = detection.region;
    if (detection.providerHint && target.provider === "自定义/CDN") target.provider = detection.providerHint;
    let pageUrl = "";
    try {
      if (tabId != null) {
        const tab = await browser.tabs.get(tabId);
        pageUrl = (tab && tab.url) || "";
      }
    } catch (e) { /* ignore */ }
    const finding = upsertFinding(target, detection, [{ id: "manual|" + rawUrl, url: rawUrl, source: "手动输入" }], pageUrl);
    emitFindings([finding]);
    return { ok: true, finding: finding };
  }

  function urlKey(rawUrl) {
    try {
      const u = new URL(rawUrl);
      return u.origin + u.pathname;
    } catch (e) {
      return String(rawUrl || "");
    }
  }

  function isScannableUrl(rawUrl) {
    return /^https?:\/\//i.test(String(rawUrl || ""));
  }

  async function autoScanTab(tabId, reason) {
    if (settings.autoScan === false) return { ok: false, skipped: "disabled" };
    if (job.running) return { ok: false, skipped: "busy" };
    let tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch (e) {
      return { ok: false, skipped: "no-tab" };
    }
    if (!tab || !tab.active || !isScannableUrl(tab.url)) return { ok: false, skipped: "not-active" };

    const key = urlKey(tab.url);
    const lastAt = autoState.get(key) || 0;
    if (lastAt && Date.now() - lastAt < AUTO_COOLDOWN_MS) {
      return { ok: false, skipped: "cooldown" };
    }

    const stored = tabHarvest.get(tabId);
    if (!stored || !stored.frames.size) {
      try {
        await browser.tabs.executeScript(tabId, { file: "src/content.js", allFrames: true, runAt: "document_idle" });
      } catch (e) { /* 特权页不可注入 */ }
      try {
        await browser.tabs.sendMessage(tabId, { type: "bh.requestHarvest" });
      } catch (e) { /* ignore */ }
      await U.sleep(800);
    }
    if (job.running) return { ok: false, skipped: "busy" };

    autoState.set(key, Date.now());
    scheduleSave();
    console.log("[BucketHunter] 自动扫描", { tabId: tabId, url: tab.url, reason: reason });
    emit({ kind: "autoscan-start", tabId: tabId, url: tab.url });
    const result = await runScan(tabId, tab.url);
    if (!result || !result.ok) {
      autoState.delete(key);
      scheduleSave();
    }
    emit({ kind: "autoscan-done", tabId: tabId, result: result });
    return result;
  }

  function scheduleAutoScan(tabId, delay) {
    if (settings.autoScan === false || tabId == null) return;
    clearTimeout(autoTimers.get(tabId));
    autoTimers.set(tabId, setTimeout(function () {
      autoTimers.delete(tabId);
      autoScanTab(tabId, "auto").catch(function () {});
    }, delay || 2500));
  }

  function deleteFindings(ids) {
    (ids || []).forEach(function (id) { delete findings[id]; });
    scheduleSave();
    emit({ kind: "deleted", ids: ids || [] });
  }

  function clearAllFindings() {
    findings = {};
    scheduleSave();
    emit({ kind: "cleared" });
  }

  browser.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "bh.harvest":
        if (sender && sender.tab && sender.tab.id != null) {
          mergeHarvest(sender.tab.id, sender.frameId || 0, msg.data);
        }
        return;

      case "bh.getState": {
        const stored = msg.tabId != null ? tabHarvest.get(msg.tabId) : null;
        sendResponse({
          ok: true,
          findings: Object.values(findings),
          job: job,
          settings: settings,
          harvest: stored ? { frames: stored.frames.size, updated: stored.updated } : null
        });
        return;
      }

      case "bh.scan":
        runScan(msg.tabId, msg.pageUrl).then(sendResponse);
        return true;

      case "bh.autoScan":
        autoScanTab(msg.tabId, "popup").then(sendResponse);
        return true;

      case "bh.write":
        runWrite(msg.id).then(sendResponse);
        return true;

      case "bh.recheck":
        runRecheck(msg.id).then(sendResponse);
        return true;

      case "bh.probeUrl":
        probeManual(msg.url, msg.tabId).then(sendResponse);
        return true;

      case "bh.stop":
        if (job.running) job.cancelled = true;
        sendResponse({ ok: true });
        return;

      case "bh.delete":
        deleteFindings(msg.ids);
        sendResponse({ ok: true });
        return;

      case "bh.clear":
        clearAllFindings();
        sendResponse({ ok: true });
        return;

      case "bh.saveSettings": {
        const autoWasOn = settings.autoScan !== false;
        settings = Object.assign({}, settings, msg.settings || {});
        scheduleSave();
        if (settings.autoScan !== false && !autoWasOn) {
          browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
            if (tabs && tabs[0]) scheduleAutoScan(tabs[0].id, 800);
          }).catch(function () {});
        }
        sendResponse({ ok: true, settings: settings });
        return;
      }

      case "bh.download": {
        try {
          const blob = new Blob([msg.content || ""], { type: msg.mime || "text/plain" });
          const url = URL.createObjectURL(blob);
          browser.downloads.download({ url: url, filename: msg.filename || "buckethunter.txt", saveAs: true })
            .finally(function () { setTimeout(function () { URL.revokeObjectURL(url); }, 120000); });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      default:
        return;
    }
  });

  browser.tabs.onUpdated.addListener(function (tabId, info, tab) {
    if (info && info.status === "loading") tabHarvest.delete(tabId);
    if (!tab || !tab.active || !isScannableUrl(tab.url)) return;
    if (info && info.status === "complete") scheduleAutoScan(tabId, 2500);
    else if (info && info.status === "loading" && info.url) scheduleAutoScan(tabId, 5000);
  });

  browser.tabs.onActivated.addListener(function (info) {
    if (info && info.tabId != null) scheduleAutoScan(info.tabId, 1500);
  });

  browser.tabs.onRemoved.addListener(function (tabId) {
    tabHarvest.delete(tabId);
    clearTimeout(autoTimers.get(tabId));
    autoTimers.delete(tabId);
  });

  setTimeout(function () {
    browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      if (tabs && tabs[0]) scheduleAutoScan(tabs[0].id, 2500);
    }).catch(function () {});
  }, 800);
})();
