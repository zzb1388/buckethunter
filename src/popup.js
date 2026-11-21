(function () {
  "use strict";

  const BH = window.BH;
  const esc = function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  const $ = function (id) { return document.getElementById(id); };

  const state = {
    tab: null,
    findings: [],
    job: null,
    settings: {},
    harvest: null,
    filter: "all",
    scopeAll: false,
    selected: new Set(),
    detailId: null,
    msg: "",
    busy: false,
    renderKey: ""
  };

  const FILTERS = [
    { id: "all", label: "全部" },
    { id: "list", label: "可列桶" },
    { id: "write", label: "可写" },
    { id: "takeover", label: "接管候选" },
    { id: "private", label: "私有" },
    { id: "error", label: "未知/失败" }
  ];

  function statusOf(f) {
    return (f.detection && f.detection.status) || "UNKNOWN";
  }
  function isTakeover(f) {
    return BH.patterns.isTakeoverCandidate(f.target, statusOf(f));
  }
  function isWritable(f) {
    return !!(f.write && f.write.result === "writable");
  }
  function originPath(u) {
    try {
      const x = new URL(u);
      return x.origin + x.pathname;
    } catch (e) {
      return String(u || "");
    }
  }

  function matchesFilter(f, filter) {
    const s = statusOf(f);
    if (filter === "list") return s === "PUBLIC_LIST";
    if (filter === "write") return isWritable(f);
    if (filter === "takeover") return isTakeover(f);
    if (filter === "private") return s === "PRIVATE";
    if (filter === "error") return s === "ERROR" || s === "UNKNOWN" || s === "REDIRECT";
    return true;
  }

  function scopedFindings() {
    return state.findings.filter(function (f) {
      if (state.scopeAll) return true;
      if (!state.tab) return true;
      if (!f.pageUrl) return true;
      return originPath(f.pageUrl) === originPath(state.tab.url);
    });
  }

  function visibleFindings() {
    return scopedFindings()
      .filter(function (f) { return matchesFilter(f, state.filter); })
      .sort(function (a, b) { return severity(b) - severity(a) || (b.lastSeen || 0) - (a.lastSeen || 0); });
  }

  function severity(f) {
    const s = statusOf(f);
    if (s === "PUBLIC_LIST" && isWritable(f)) return 100;
    if (isWritable(f)) return 95;
    if (s === "PUBLIC_LIST") return 90;
    if (isTakeover(f)) return 80;
    if (s === "PRIVATE") return 40;
    if (s === "NOT_BUCKET") return 10;
    if (s === "ERROR") return 15;
    return 25;
  }

  function statusText(s) {
    return {
      PUBLIC_LIST: "可匿名列桶",
      PRIVATE: "存在(拒绝匿名)",
      NOT_EXISTS: "桶不存在",
      NOT_BUCKET: "非存储桶",
      REDIRECT: "重定向",
      UNKNOWN: "未知",
      ERROR: "请求失败"
    }[s] || s || "未知";
  }

  function writeText(w) {
    if (!w) return "未测";
    if (w.result === "writable") return "可匿名写";
    if (w.result === "denied") return "被拒绝";
    if (w.result === "error") return "请求失败";
    return "失败";
  }

  function verdict(f) {
    const s = statusOf(f);
    const w = isWritable(f);
    if (s === "PUBLIC_LIST" && w) return "严重:可匿名列桶 + 可匿名写入(可覆盖对象)";
    if (s === "PUBLIC_LIST") return "高危:可匿名列桶";
    if (w) return "高危:可匿名写入(可覆盖对象)";
    if (isTakeover(f)) {
      return f.target.cnameFrom
        ? "接管候选:" + f.target.cnameFrom + " 的 CNAME 指向不存在的桶"
        : "接管候选:桶不存在,名称可能可抢注";
    }
    if (s === "PRIVATE") return "信息:桶存在,拒绝匿名访问";
    if (s === "NOT_BUCKET") return "非存储桶端点";
    if (s === "ERROR") return "探测失败:" + ((f.detection && f.detection.error) || "");
    return "未知(需人工确认)";
  }

  function statusBadge(f) {
    const s = statusOf(f);
    if (s === "PUBLIC_LIST") return '<span class="badge red">可列桶</span>';
    if (s === "PRIVATE") return '<span class="badge">存在·私有</span>';
    if (s === "NOT_EXISTS") {
      return isTakeover(f)
        ? '<span class="badge orange">不存在·可接管?</span>'
        : '<span class="badge orange">不存在</span>';
    }
    if (s === "NOT_BUCKET") return '<span class="badge dim">非桶</span>';
    if (s === "ERROR") return '<span class="badge yellow">请求失败</span>';
    if (s === "REDIRECT") return '<span class="badge yellow">重定向</span>';
    return '<span class="badge dim">未知</span>';
  }

  function writeBadge(f) {
    const w = f.write;
    if (!w) return '<span class="badge dim">未测</span>';
    if (w.result === "writable") return '<span class="badge red">可写</span>';
    if (w.result === "denied") return '<span class="badge">拒绝</span>';
    return '<span class="badge yellow">失败</span>';
  }

  function targetLabel(f) {
    const t = f.target;
    return t.bucket || t.host;
  }

  function setMsg(text) {
    state.msg = text || "";
    renderProgress();
  }

  /* ---------- 渲染 ---------- */

  function renderChips() {
    const base = scopedFindings();
    $("chips").innerHTML = FILTERS.map(function (item) {
      const count = item.id === "all" ? base.length : base.filter(function (f) { return matchesFilter(f, item.id); }).length;
      return '<button class="chip' + (state.filter === item.id ? " active" : "") + '" data-filter="' + item.id + '">' +
        esc(item.label) + "<b>" + count + "</b></button>";
    }).join("");
  }

  function renderProgress() {
    const job = state.job;
    const running = !!(job && job.running);
    $("btnStop").disabled = !running;
    let percent = 0;
    let text = "空闲";
    if (job) {
      if (job.running) {
        if (job.phase === "collect") text = "解析 JS " + job.done + " / " + job.total;
        else if (job.phase === "chunks") text = "抓取 chunk " + job.done + " / " + job.total;
        else if (job.phase === "cname") text = "解析 CNAME " + job.done + " / " + job.total;
        else text = "探测目标 " + job.done + " / " + job.total;
        percent = job.total ? Math.round((job.done / job.total) * 100) : 8;
      } else if (job.phase === "done") {
        const st = job.stats || {};
        text = "完成:命中 " + (job.targets || 0) + " · 帧 " + (st.frames || 0) +
          " · JS " + (st.jsOk || 0) + "/" + (st.jsTotal || 0) +
          " · Chunk " + (st.chunksFetched || 0) + "/" + (st.chunkTried || 0) +
          " · 候选 " + (st.candidates || 0) + " · CNAME桶 " + (st.cnameBuckets || 0);
        percent = 100;
      } else if (job.phase === "cancelled") {
        text = "已停止";
      } else if (job.phase === "error") {
        text = "出错:" + (job.error || "");
      }
    }
    if (!running && state.harvest && state.harvest.frames) {
      text += " · 采集帧 " + state.harvest.frames;
    }
    if (state.msg) {
      text = state.msg;
      state.msg = "";
    }
    $("progressFill").style.width = percent + "%";
    $("progressText").textContent = text;
  }

  function rowHtml(f) {
    const t = f.target;
    const checked = state.selected.has(f.id) ? " checked" : "";
    const name = t.bucket || t.host;
    const sub = t.bucket ? (t.host + (t.container ? "/" + t.container : "")) : (t.pathHint || "");
    const cdn = t.cdn ? ' <span class="badge dim">CDN</span>' : "";
    return '<tr data-id="' + f.id + '">' +
      '<td class="cb"><input type="checkbox" class="rowchk" data-id="' + f.id + '"' + checked + "></td>" +
      '<td class="tname"><div class="name">' + esc(name) + '</div><div class="sub">' + esc(sub) + "</div></td>" +
      "<td>" + esc(t.provider) + cdn + "</td>" +
      "<td>" + esc(t.region || "-") + "</td>" +
      "<td>" + statusBadge(f) + "</td>" +
      "<td>" + writeBadge(f) + "</td>" +
      '<td class="ops">' +
      '<button data-act="write" data-id="' + f.id + '">PUT</button>' +
      '<button data-act="recheck" data-id="' + f.id + '">复查</button>' +
      '<button data-act="detail" data-id="' + f.id + '">详情</button>' +
      "</td></tr>";
  }

  function renderTable() {
    const items = visibleFindings();
    const wrap = document.querySelector(".tablewrap");
    const scrollTop = wrap ? wrap.scrollTop : 0;
    $("rows").innerHTML = items.map(rowHtml).join("");
    if (wrap) wrap.scrollTop = scrollTop;
    $("empty").hidden = items.length > 0;
    const visibleIds = items.map(function (f) { return f.id; });
    const allSelected = visibleIds.length > 0 && visibleIds.every(function (id) { return state.selected.has(id); });
    $("checkAll").checked = allSelected;
  }

  function renderDetail() {
    const box = $("detail");
    const f = state.findings.find(function (x) { return x.id === state.detailId; });
    if (!f) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    const t = f.target;
    const d = f.detection || {};
    const w = f.write;
    const headerLines = Object.keys(d.headers || {}).map(function (k) { return k + ": " + d.headers[k]; }).join("\n") || "(无)";
    const refs = (f.refs || []).map(function (r) {
      return "<li>" + esc(r.url) + ' <span class="hint">← ' + esc(r.source) + "</span></li>";
    }).join("") || "<li>(无)</li>";

    let writeHtml;
    if (w) {
      writeHtml = '<div class="kv">' +
        '<div class="k">结果</div><div class="v">' +
        (w.result === "writable" ? '<span class="badge red">可匿名写入</span>' : (w.result === "denied" ? '<span class="badge">被拒绝</span>' : '<span class="badge yellow">失败</span>')) +
        " HTTP " + esc(w.httpStatus || "-") + "</div>" +
        '<div class="k">PUT</div><div class="v">' + esc(w.probeUrl) + "</div>" +
        (w.readback ? '<div class="k">回读</div><div class="v">HTTP ' + esc(w.readback.httpStatus) +
          (w.readback.public ? " (可公开读取)" : " (不可匿名读取)") + "</div>" : "") +
        "</div>" +
        '<div class="hint warn">探针文件 ' + esc(w.key) + " 不会自动删除(工具不做 DELETE),需要人工清理。</div>";
    } else {
      writeHtml = '<div class="hint">尚未写入探针。点击「PUT 探针」会写入一个唯一随机文件,不覆盖、不删除。</div>';
    }

    box.innerHTML =
      '<div class="dhead"><h3>' + esc(t.bucket || t.host) + ' <span class="badge dim">' + esc(t.provider) + "</span></h3>" +
      '<div class="btns">' +
      '<button data-copy="' + esc(d.requestUrl || "") + '">复制请求URL</button>' +
      (w ? '<button data-copy="' + esc(w.probeUrl) + '">复制探针URL</button>' : "") +
      '<button data-act="putdetail" data-id="' + f.id + '">PUT 探针</button>' +
      '<button data-act="closedetail">关闭</button></div></div>' +
      '<div class="kv">' +
      '<div class="k">探测地址</div><div class="v">' + esc(t.baseUrl) + "</div>" +
      (t.cnameFrom ? '<div class="k">CNAME</div><div class="v">' + esc(t.cnameFrom) + " → " + esc(t.host) + "</div>" : "") +
      '<div class="k">存在性</div><div class="v">' + esc(statusText(d.status)) + " (HTTP " + esc(d.httpStatus || "-") + ")</div>" +
      '<div class="k">请求</div><div class="v">' + esc(d.requestMethod || "") + " " + esc(d.requestUrl || "") + "</div>" +
      '<div class="k">错误码</div><div class="v">' + esc(d.code || "-") + (d.note ? " · " + esc(d.note) : "") + "</div>" +
      "</div>" +
      "<pre>" + esc(headerLines) + "</pre>" +
      '<div class="kv"><div class="k">响应片段</div><div class="v"></div></div>' +
      "<pre>" + esc(d.bodySnippet || d.error || "(空)") + "</pre>" +
      '<div class="kv"><div class="k">写入</div><div class="v"></div></div>' +
      writeHtml +
      '<div class="kv"><div class="k">来源</div><div class="v"></div></div>' +
      '<ul class="refs">' + refs + "</ul>";
    box.hidden = false;
  }

  function currentRenderKey() {
    const job = state.job;
    return state.findings.map(function (f) {
      return f.id + ":" + statusOf(f) + ":" + (f.write ? f.write.result : "");
    }).join("|") + "#" + (job ? job.phase + ":" + job.done + ":" + job.total + ":" + (job.running ? 1 : 0) : "") +
      "#" + state.filter + "#" + (state.scopeAll ? 1 : 0) + "#" + state.detailId + "#" + (state.tab ? state.tab.url : "");
  }

  function render(force) {
    renderProgress();
    const key = currentRenderKey();
    if (!force && key === state.renderKey) return;
    state.renderKey = key;
    renderChips();
    renderTable();
    renderDetail();
  }

  /* ---------- 数据 ---------- */

  async function loadState(first) {
    try {
      const st = await browser.runtime.sendMessage({ type: "bh.getState", tabId: state.tab ? state.tab.id : null });
      if (st && st.ok) {
        state.findings = st.findings || [];
        state.job = st.job || null;
        state.settings = st.settings || state.settings || {};
        state.harvest = st.harvest || null;
        fillSettings(!!first);
      }
    } catch (e) { /* ignore */ }
  }

  function fillSettings(force) {
    const s = state.settings || {};
    const setValue = function (id, value) {
      const el = $(id);
      if (!el) return;
      if (!force && document.activeElement === el) return;
      if (el.type === "checkbox") el.checked = !!value;
      else el.value = value;
    };
    setValue("setMaxJs", s.maxJsFiles);
    setValue("setConc", s.concurrency);
    setValue("setTimeout", s.timeoutMs);
    setValue("setMaxKb", Math.round((s.maxJsBytes || 0) / 1024));
    setValue("setAutoScan", s.autoScan);
    setValue("setChunkLimit", s.chunkLimit);
    setValue("setCrawlChunks", s.crawlChunks);
    setValue("setAutoWrite", s.autoWrite);
    setValue("setCname", s.resolveCname);
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function saveSettings() {
    const payload = {
      maxJsFiles: clampInt($("setMaxJs").value, 0, 2000, 300),
      concurrency: clampInt($("setConc").value, 1, 10, 4),
      timeoutMs: clampInt($("setTimeout").value, 2000, 60000, 12000),
      maxJsBytes: clampInt($("setMaxKb").value, 256, 16384, 4096) * 1024,
      chunkLimit: clampInt($("setChunkLimit").value, 0, 2000, 300),
      crawlChunks: $("setCrawlChunks").checked,
      autoScan: $("setAutoScan").checked,
      autoWrite: $("setAutoWrite").checked,
      resolveCname: $("setCname").checked
    };
    state.settings = Object.assign({}, state.settings, payload);
    browser.runtime.sendMessage({ type: "bh.saveSettings", settings: payload }).catch(function () {});
  }

  /* ---------- 动作 ---------- */

  async function startScan() {
    if (!state.tab || state.busy) return;
    state.busy = true;
    $("btnScan").disabled = true;
    setMsg("正在采集页面资源…");
    try {
      try {
        await browser.tabs.executeScript(state.tab.id, { file: "src/content.js", allFrames: true, runAt: "document_idle" });
      } catch (e) { /* 特权页面无权限注入 */ }
      try {
        await browser.tabs.sendMessage(state.tab.id, { type: "bh.requestHarvest" });
      } catch (e) { /* ignore */ }
      await BH.util.sleep(600);
      const result = await browser.runtime.sendMessage({
        type: "bh.scan", tabId: state.tab.id, pageUrl: state.tab.url
      });
      if (!result.ok) setMsg(result.error || "扫描失败");
      else if (result.cancelled) setMsg("已停止");
      else if (!result.targetCount) {
        const st = result.stats || {};
        setMsg("未发现存储桶引用 · 帧 " + (st.frames || 0) + " / JS " + (st.jsOk || 0) + "/" + (st.jsTotal || 0) +
          " / 候选 " + (st.candidates || 0) + " / CNAME桶 " + (st.cnameBuckets || 0));
      } else setMsg("扫描完成:命中 " + result.targetCount + " 个目标");
    } catch (e) {
      setMsg("扫描出错:" + ((e && e.message) || e));
    } finally {
      state.busy = false;
      $("btnScan").disabled = false;
      await loadState();
      render(true);
    }
  }

  async function doWrite(finding) {
    const t = finding.target;
    const ok = window.confirm(
      "对以下目标发送匿名 PUT 探针?\n\n" + t.provider + "  " + (t.bucket || t.host) + "\n" + t.baseUrl +
      "\n\n只会写入 bh-probe-<随机>.txt,不会覆盖或删除任何文件。"
    );
    if (!ok) return;
    setMsg("正在写入探针…");
    try {
      const result = await browser.runtime.sendMessage({ type: "bh.write", id: finding.id });
      if (!result.ok) setMsg(result.error || "写入失败");
      else if (result.write.result === "writable") setMsg("写入成功:该桶可匿名写入");
      else if (result.write.result === "denied") setMsg("写入被拒绝");
      else setMsg("写入失败");
    } catch (e) {
      setMsg("写入出错:" + ((e && e.message) || e));
    }
    await loadState();
    render(true);
  }

  async function doRecheck(finding) {
    setMsg("复查中…");
    try {
      const result = await browser.runtime.sendMessage({ type: "bh.recheck", id: finding.id });
      if (!result.ok) setMsg(result.error || "复查失败");
      else setMsg("复查完成:" + statusText(result.detection.status));
    } catch (e) {
      setMsg("复查出错:" + ((e && e.message) || e));
    }
    await loadState();
    render(true);
  }

  async function manualProbe() {
    const url = $("manualUrl").value.trim();
    if (!url) return;
    setMsg("探测中:" + url);
    try {
      const result = await browser.runtime.sendMessage({
        type: "bh.probeUrl", url: url, tabId: state.tab ? state.tab.id : null
      });
      if (result.ok && result.finding) {
        state.detailId = result.finding.id;
        setMsg("探测完成:" + statusText(result.finding.detection.status));
      } else {
        setMsg(result.error || "探测失败");
      }
    } catch (e) {
      setMsg("探测出错:" + ((e && e.message) || e));
    }
    await loadState();
    render(true);
  }

  async function deleteSelected() {
    const ids = Array.from(state.selected);
    if (!ids.length) {
      setMsg("未选中任何记录");
      return;
    }
    if (!window.confirm("清除选中的 " + ids.length + " 条扫描记录?\n(仅清除记录,不会删除桶内任何文件)")) return;
    await browser.runtime.sendMessage({ type: "bh.delete", ids: ids });
    ids.forEach(function (id) { state.selected.delete(id); });
    await loadState();
    render(true);
  }

  async function clearAll() {
    if (!state.findings.length) {
      setMsg("没有记录可清除");
      return;
    }
    if (!window.confirm("清除全部 " + state.findings.length + " 条扫描记录?\n(仅清除记录,不会删除桶内任何文件)")) return;
    await browser.runtime.sendMessage({ type: "bh.clear" });
    state.selected.clear();
    state.detailId = null;
    await loadState();
    render(true);
  }

  /* ---------- 导出 ---------- */

  function cell(value) {
    return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  }

  function buildMarkdown() {
    const items = visibleFindings();
    const lines = [];
    lines.push("# BucketHunter 扫描结果");
    lines.push("");
    lines.push("- 生成时间:" + new Date().toLocaleString());
    lines.push("- 当前页面:" + (state.tab ? state.tab.url : "-"));
    lines.push("- 导出目标数:" + items.length);
    lines.push("");
    lines.push("## 汇总");
    lines.push("");
    lines.push("| # | 目标 | 云商 | 区域 | 存在性/列表 | 写入 | 结论 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    items.forEach(function (f, i) {
      const d = f.detection || {};
      lines.push("| " + (i + 1) + " | " + cell(targetLabel(f)) + " | " + cell(f.target.provider) +
        " | " + cell(f.target.region || "-") + " | " + cell(statusText(d.status) + " (HTTP " + (d.httpStatus || "-") + ")") +
        " | " + cell(writeText(f.write)) + " | " + cell(verdict(f)) + " |");
    });
    lines.push("");
    lines.push("## 明细");

    items.forEach(function (f, i) {
      const d = f.detection || {};
      lines.push("");
      lines.push("### " + (i + 1) + ". " + targetLabel(f));
      lines.push("");
      lines.push("- 云商:" + f.target.provider + (f.target.region ? " / " + f.target.region : ""));
      lines.push("- 探测地址:" + f.target.baseUrl);
      if (f.target.cnameFrom) lines.push("- CNAME:" + f.target.cnameFrom + " → " + f.target.host);
      lines.push("- 结论:" + verdict(f));
      lines.push("- 存在性:" + statusText(d.status) + " (HTTP " + (d.httpStatus || "-") + ")");
      lines.push("- 请求:" + (d.requestMethod || "") + " " + (d.requestUrl || ""));
      if (d.code) lines.push("- 错误码:" + d.code + (d.message ? " (" + d.message + ")" : ""));
      if (d.note) lines.push("- 备注:" + d.note);
      lines.push("- 响应头:");
      lines.push("```");
      const hs = d.headers || {};
      Object.keys(hs).forEach(function (k) { lines.push(k + ": " + hs[k]); });
      if (!Object.keys(hs).length) lines.push("(无)");
      lines.push("```");
      lines.push("- 响应片段:");
      lines.push("```");
      lines.push(d.bodySnippet || d.error || "(空)");
      lines.push("```");
      if (f.write) {
        lines.push("- 写入探针:" + writeText(f.write) + " · PUT " + f.write.probeUrl + " → HTTP " + (f.write.httpStatus || "-"));
        if (f.write.readback) {
          lines.push("- 回读:" + (f.write.readback.public ? "可匿名读取" : "不可匿名读取") + " (HTTP " + f.write.readback.httpStatus + ")");
        }
        lines.push("- 探针文件:" + f.write.key + "(未删除)");
      } else {
        lines.push("- 写入探针:未测试");
      }
      lines.push("- 来源:");
      const refs = f.refs || [];
      if (!refs.length) lines.push("  - (无)");
      refs.forEach(function (r) {
        lines.push("  - " + r.url + "  ← " + (r.source || ""));
      });
    });
    lines.push("");
    return lines.join("\n");
  }

  function timestampName(ext) {
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return "buckethunter-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" +
      pad(d.getHours()) + pad(d.getMinutes()) + "." + ext;
  }

  function downloadText(filename, content, mime) {
    browser.runtime.sendMessage({
      type: "bh.download", filename: filename, content: content, mime: mime
    }).catch(function () {});
  }

  function exportMarkdown() {
    downloadText(timestampName("md"), buildMarkdown(), "text/markdown;charset=utf-8");
  }

  function exportJson() {
    const items = visibleFindings();
    const payload = {
      generator: "BucketHunter 0.1",
      generatedAt: new Date().toISOString(),
      page: state.tab ? state.tab.url : "",
      count: items.length,
      findings: items
    };
    downloadText(timestampName("json"), JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  }

  /* ---------- 事件 ---------- */

  function bind() {
    $("btnScan").addEventListener("click", startScan);
    $("btnStop").addEventListener("click", function () {
      browser.runtime.sendMessage({ type: "bh.stop" }).catch(function () {});
      setMsg("正在停止…");
    });
    $("btnManual").addEventListener("click", manualProbe);
    $("manualUrl").addEventListener("keydown", function (e) {
      if (e.key === "Enter") manualProbe();
    });
    $("btnDelSel").addEventListener("click", deleteSelected);
    $("btnClearAll").addEventListener("click", clearAll);
    $("btnExportMd").addEventListener("click", exportMarkdown);
    $("btnExportJson").addEventListener("click", exportJson);

    $("chips").addEventListener("click", function (e) {
      const chip = e.target.closest("[data-filter]");
      if (!chip) return;
      state.filter = chip.getAttribute("data-filter");
      state.renderKey = "";
      render(true);
    });

    $("scopeAll").addEventListener("change", function (e) {
      state.scopeAll = e.target.checked;
      state.renderKey = "";
      render(true);
    });

    $("checkAll").addEventListener("change", function (e) {
      const items = visibleFindings();
      items.forEach(function (f) {
        if (e.target.checked) state.selected.add(f.id);
        else state.selected.delete(f.id);
      });
      renderTable();
    });

    $("rows").addEventListener("change", function (e) {
      const target = e.target;
      if (!target || !target.classList.contains("rowchk")) return;
      const id = target.getAttribute("data-id");
      if (target.checked) state.selected.add(id);
      else state.selected.delete(id);
      const visibleIds = visibleFindings().map(function (f) { return f.id; });
      $("checkAll").checked = visibleIds.length > 0 && visibleIds.every(function (x) { return state.selected.has(x); });
    });

    $("rows").addEventListener("click", async function (e) {
      const btn = e.target.closest("button[data-act]");
      if (btn) {
        const id = btn.getAttribute("data-id");
        const finding = state.findings.find(function (f) { return f.id === id; });
        if (!finding) return;
        const act = btn.getAttribute("data-act");
        if (act === "write") doWrite(finding);
        else if (act === "recheck") doRecheck(finding);
        else if (act === "detail") {
          state.detailId = state.detailId === id ? null : id;
          renderDetail();
        }
        return;
      }
      const cellEl = e.target.closest("td.tname");
      if (cellEl) {
        const row = cellEl.closest("tr");
        const id = row && row.getAttribute("data-id");
        state.detailId = state.detailId === id ? null : id;
        renderDetail();
      }
    });

    $("detail").addEventListener("click", function (e) {
      const copyBtn = e.target.closest("[data-copy]");
      if (copyBtn) {
        const text = copyBtn.getAttribute("data-copy") || "";
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
        setMsg("已复制");
        return;
      }
      const actBtn = e.target.closest("button[data-act]");
      if (actBtn) {
        const act = actBtn.getAttribute("data-act");
        if (act === "closedetail") {
          state.detailId = null;
          renderDetail();
        } else if (act === "putdetail") {
          const finding = state.findings.find(function (f) { return f.id === actBtn.getAttribute("data-id"); });
          if (finding) doWrite(finding);
        }
      }
    });

    ["setAutoScan", "setMaxJs", "setConc", "setTimeout", "setMaxKb", "setChunkLimit", "setCrawlChunks", "setAutoWrite", "setCname"].forEach(function (id) {
      $(id).addEventListener("change", saveSettings);
    });

    browser.runtime.onMessage.addListener(function (msg) {
      if (!msg || msg.type !== "bh.event") return;
      const evt = msg.evt || {};
      if (evt.kind === "job" && evt.job) {
        state.job = evt.job;
        renderProgress();
      } else if (evt.kind === "findings" && evt.items) {
        evt.items.forEach(function (item) {
          const idx = state.findings.findIndex(function (x) { return x.id === item.id; });
          if (idx >= 0) state.findings[idx] = item;
          else state.findings.push(item);
        });
        render();
      } else if (evt.kind === "deleted" || evt.kind === "cleared") {
        loadState().then(function () { render(true); });
      }
    });
  }

  async function init() {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      state.tab = tabs && tabs[0] ? tabs[0] : null;
    } catch (e) {
      state.tab = null;
    }
    if (state.tab) {
      $("pageInfo").textContent = state.tab.title || state.tab.url || "";
      $("pageInfo").title = state.tab.url || "";
      try {
        await browser.tabs.executeScript(state.tab.id, { file: "src/content.js", allFrames: true, runAt: "document_idle" });
      } catch (e) { /* 特权页不可注入 */ }
      try {
        await browser.tabs.sendMessage(state.tab.id, { type: "bh.requestHarvest" });
      } catch (e) { /* content script 尚未就绪 */ }
    } else {
      $("pageInfo").textContent = "当前标签页不可用";
    }

    bind();
    await loadState(true);
    render(true);

    if (state.tab && state.settings.autoScan !== false) {
      setTimeout(function () {
        browser.runtime.sendMessage({ type: "bh.autoScan", tabId: state.tab.id }).catch(function () {});
      }, 600);
    }

    setInterval(async function () {
      await loadState(false);
      render();
    }, 1500);
  }

  init();
})();
