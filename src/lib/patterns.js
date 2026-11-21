(function () {
  const BH = window.BH;
  const U = BH.util;

  // 全局唯一的桶名空间 —— NoSuchBucket 才有接管可能
  const TAKEOVER_PROVIDERS = new Set([
    "AWS S3", "Aliyun OSS", "Tencent COS", "Huawei OBS", "Google GCS",
    "Backblaze B2", "DigitalOcean Spaces", "Cloudflare R2",
    "Kingsoft KS3", "Baidu BOS", "UCloud UFile"
  ]);

  const BOS_REGIONS = new Set(["bj", "gz", "su", "hkg", "sin", "fwh", "bd", "nj", "cd"]);

  // style: virtual | path | azure
  // bucket / region 指向正则捕获组; path 风格的桶名取 URL 第一段路径
  const RULES = [
    { id: "s3-dualstack", provider: "AWS S3", re: /^(.+)\.s3\.dualstack\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/i, style: "virtual", bucket: 1, region: 2 },
    { id: "s3-virtual", provider: "AWS S3", re: /^(.+)\.s3(?:[.-]([a-z0-9-]+))?\.amazonaws\.com(?:\.cn)?$/i, style: "virtual", bucket: 1, region: 2 },
    { id: "s3-path", provider: "AWS S3", re: /^s3(?:[.-]([a-z0-9-]+))?\.amazonaws\.com(?:\.cn)?$/i, style: "path", region: 1 },

    { id: "oss-virtual", provider: "Aliyun OSS", re: /^(.+)\.oss-([a-z0-9-]+?)\.aliyuncs\.com$/i, style: "virtual", bucket: 1, region: 2 },
    { id: "oss-virtual-internal", provider: "Aliyun OSS", re: /^(.+)\.oss-([a-z0-9-]+?)-internal\.aliyuncs\.com$/i, style: "virtual", bucket: 1, region: 2 },
    { id: "oss-path", provider: "Aliyun OSS", re: /^oss-([a-z0-9-]+?)\.aliyuncs\.com$/i, style: "path", region: 1 },

    { id: "cos-virtual", provider: "Tencent COS", re: /^(.+)\.cos\.([a-z0-9-]+)\.myqcloud\.com$/i, style: "virtual", bucket: 1, region: 2 },
    { id: "cos-path", provider: "Tencent COS", re: /^cos\.([a-z0-9-]+)\.myqcloud\.com$/i, style: "path", region: 1 },
    { id: "cos-old", provider: "Tencent COS", re: /^(.+)\.cos\.([a-z0-9-]+)\.tencentcos\.cn$/i, style: "virtual", bucket: 1, region: 2 },

    { id: "obs-virtual", provider: "Huawei OBS", re: /^(.+)\.obs\.([a-z0-9-]+)\.myhuaweicloud\.com$/i, style: "virtual", bucket: 1, region: 2 },
    { id: "obs-path", provider: "Huawei OBS", re: /^obs\.([a-z0-9-]+)\.myhuaweicloud\.com$/i, style: "path", region: 1 },

    { id: "gcs-virtual", provider: "Google GCS", re: /^(.+)\.storage\.googleapis\.com$/i, style: "virtual", bucket: 1 },
    { id: "gcs-path", provider: "Google GCS", re: /^storage\.googleapis\.com$/i, style: "path" },

    { id: "azure", provider: "Azure Blob", re: /^([a-z0-9]+)\.blob\.core\.(?:windows\.net|chinacloudapi\.cn)$/i, style: "azure", bucket: 1 },

    { id: "r2", provider: "Cloudflare R2", re: /^([a-z0-9]+)\.r2\.cloudflarestorage\.com$/i, style: "path" },
    { id: "do-virtual", provider: "DigitalOcean Spaces", re: /^(.+)\.([a-z0-9-]+)\.digitaloceanspaces\.com$/i, style: "virtual", bucket: 1, region: 2 },
    { id: "do-path", provider: "DigitalOcean Spaces", re: /^([a-z0-9-]+)\.digitaloceanspaces\.com$/i, style: "path", region: 1 },
    { id: "b2", provider: "Backblaze B2", re: /^(.+)\.s3\.([a-z0-9-]+)\.backblazeb2\.com$/i, style: "virtual", bucket: 1, region: 2 },
    { id: "ks3", provider: "Kingsoft KS3", re: /^(.+)\.ks3(?:[.-]([a-z0-9-]+))?\.ksyuncs\.com$/i, style: "virtual", bucket: 1, region: 2 },

    { id: "upyun", provider: "Upyun", re: /^(.+)\.(?:b0\.upaiyun\.com|upcdn\.b0\.upaiyun\.com)$/i, style: "virtual", bucket: 1, unknown: true },
    { id: "ucloud", provider: "UCloud UFile", re: /^(.+?)\.(?:([a-z0-9-]+)\.)?ufileos\.com$/i, style: "virtual", bucket: 1, region: 2, unknown: true },
    { id: "qiniu", provider: "Qiniu", re: /^(.+)\.(?:qiniudn\.com|qnssl\.com|clouddn\.com)$/i, style: "virtual", bucket: 1, unknown: true }
  ];

  const SUFFIX_RE = /\.(?:amazonaws\.com(?:\.cn)?|aliyuncs\.com|myqcloud\.com|tencentcos\.cn|myhuaweicloud\.com|storage\.googleapis\.com|blob\.core\.windows\.net|blob\.core\.chinacloudapi\.cn|bcebos\.com|ufileos\.com|ksyuncs\.com|digitaloceanspaces\.com|backblazeb2\.com|r2\.cloudflarestorage\.com|qiniudn\.com|qnssl\.com|clouddn\.com|b0\.upaiyun\.com)$/i;

  const SUFFIX_ALT = "(?:amazonaws\\.com(?:\\.cn)?|aliyuncs\\.com|myqcloud\\.com|tencentcos\\.cn|myhuaweicloud\\.com|storage\\.googleapis\\.com|blob\\.core\\.windows\\.net|blob\\.core\\.chinacloudapi\\.cn|bcebos\\.com|ufileos\\.com|ksyuncs\\.com|digitaloceanspaces\\.com|backblazeb2\\.com|r2\\.cloudflarestorage\\.com|qiniudn\\.com|qnssl\\.com|clouddn\\.com|b0\\.upaiyun\\.com)";
  const URL_RE = /(?:https?:)?\/\/[a-z0-9][a-z0-9.\-]*(?::\d{1,5})?(?:\/[^\s"'`<>()\[\]{}\\,;|]*)?/gi;
  const BARE_RE = new RegExp("(?<![a-z0-9.\\-])((?:[a-z0-9][a-z0-9.\\-]*\\.)?" + SUFFIX_ALT + ")(:\\d{1,5})?(\\/[^\\s\"'`<>()\\[\\]{}\\\\,;|]*)?", "gi");

  function normalizeUrlString(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    s = s.replace(/\\\//g, "/")
      .replace(/\\u002[fF]/g, "/")
      .replace(/\\u003[aA]/g, ":")
      .replace(/\\x2[fF]/gi, "/")
      .replace(/\\x3[aA]/gi, ":");
    s = s.replace(/^[("'`<\[]+/, "").replace(/[)"'`>\].,;]+$/, "");
    if (!s) return null;
    if (s.startsWith("//")) return "https:" + s;
    if (/^https?:\/\//i.test(s)) return s;
    const bareHost = s.split("/")[0].split("?")[0].split("#")[0];
    if (SUFFIX_RE.test(bareHost)) return "https://" + s;
    return null;
  }

  function mkTarget(provider, host, bucket, container, region, style, baseUrl, extra) {
    const target = {
      key: [provider, host, bucket || "", container || ""].join("|"),
      provider: provider,
      host: host,
      bucket: bucket || "",
      container: container || "",
      region: region || "",
      style: style,
      baseUrl: baseUrl
    };
    if (extra) Object.assign(target, extra);
    return target;
  }

  function splitSegments(u) {
    try {
      return u.pathname.split("/").filter(Boolean).map(function (x) { return decodeURIComponent(x); });
    } catch (e) {
      return u.pathname.split("/").filter(Boolean);
    }
  }

  function classifyBos(host, segs, scheme) {
    const base = scheme || "https:";
    const labels = host.split(".");
    if (labels.length === 3 && BOS_REGIONS.has(labels[0])) {
      if (!segs.length || !U.objectNameOk(segs[0])) return null;
      return mkTarget("Baidu BOS", host, segs[0], "", labels[0], "path", base + "//" + host + "/" + encodeURIComponent(segs[0]), { scheme: base });
    }
    if (labels.length === 3) {
      return mkTarget("Baidu BOS", host, labels[0], "", "", "virtual", base + "//" + host, { scheme: base });
    }
    if (labels.length === 4) {
      return mkTarget("Baidu BOS", host, labels[0], "", labels[1], "virtual", base + "//" + host, { scheme: base });
    }
    return null;
  }

  function classifyUrl(raw) {
    const normalized = normalizeUrlString(raw);
    if (!normalized) return null;
    let u;
    try { u = new URL(normalized); } catch (e) { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    if (!host || host.indexOf(".") === -1) return null;
    const segs = splitSegments(u);
    const scheme = u.protocol === "http:" ? "http:" : "https:";

    if (/(?:^|\.)bcebos\.com$/i.test(host)) return classifyBos(host, segs, scheme);

    for (let i = 0; i < RULES.length; i++) {
      const rule = RULES[i];
      const m = host.match(rule.re);
      if (!m) continue;

      let bucket = rule.bucket ? (m[rule.bucket] || "") : "";
      let region = rule.region ? (m[rule.region] || "") : "";
      let container = "";

      if (rule.style === "azure") {
        if (!segs.length) return null;
        container = segs[0];
        bucket = m[rule.bucket] || host.split(".")[0];
        return mkTarget("Azure Blob", host, bucket, container, "", "azure",
          scheme + "//" + host + "/" + encodeURIComponent(container), { account: bucket, scheme: scheme });
      }

      if (rule.style === "path") {
        if (!bucket) bucket = segs[0] || "";
        if (!U.objectNameOk(bucket)) return null;
      }
      if (!bucket) return null;

      const baseUrl = rule.style === "path"
        ? scheme + "//" + host + "/" + encodeURIComponent(bucket)
        : scheme + "//" + host;

      return mkTarget(rule.provider, host, bucket, "", region, rule.style, baseUrl, {
        rule: rule.id,
        scheme: scheme,
        cdn: rule.unknown ? true : undefined
      });
    }
    return null;
  }

  function makeGenericTarget(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (!u.hostname || u.hostname.indexOf(".") === -1) return null;
    const host = u.hostname.toLowerCase();
    const scheme = u.protocol === "http:" ? "http:" : "https:";
    return mkTarget("自定义/CDN", host, "", "", "", "url", scheme + "//" + host, {
      rule: "generic",
      scheme: scheme,
      pathHint: u.pathname && u.pathname !== "/" ? u.pathname : ""
    });
  }

  function addTarget(sink, target, ref, rawUrl) {
    let entry = sink.get(target.key);
    if (!entry) {
      entry = { target: target, refs: [] };
      sink.set(target.key, entry);
    }
    const refKey = String(ref || "") + "|" + String(rawUrl || "");
    if (entry.refs.length < 12 && !entry.refs.some(function (r) { return r.id === refKey; })) {
      entry.refs.push({ id: refKey, url: U.truncate(rawUrl, 400), source: ref || "" });
    }
  }

  function extract(text, ref, sink) {
    if (!text) return;
    let t = String(text);
    const MAX_TEXT = 8 * 1024 * 1024;
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT);
    t = t.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/").replace(/\\x2[fF]/gi, "/");

    const found = new Set();
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(t))) {
      found.add(m[0]);
      if (found.size >= 4000) break;
    }
    BARE_RE.lastIndex = 0;
    while ((m = BARE_RE.exec(t))) {
      found.add(m[0]);
      if (found.size >= 8000) break;
    }

    found.forEach(function (rawUrl) {
      const target = classifyUrl(rawUrl);
      if (target) addTarget(sink, target, ref, rawUrl);
    });
  }

  function isTakeoverCandidate(target, status) {
    return status === "NOT_EXISTS" && TAKEOVER_PROVIDERS.has(target.provider);
  }

  function hostFromUrl(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    if (s.startsWith("//")) s = "https:" + s;
    if (!/^https?:\/\//i.test(s)) return "";
    try {
      return new URL(s).hostname.toLowerCase();
    } catch (e) {
      return "";
    }
  }

  function extractHosts(text, counts, limit) {
    if (!text) return;
    const max = limit || 800;
    const re = /(?:https?:)?\/\/([a-z0-9][a-z0-9.\-]*\.[a-z0-9.\-]+)(?::\d{1,5})?/gi;
    let m;
    let guard = 0;
    while ((m = re.exec(String(text))) && guard++ < 20000) {
      const host = m[1].toLowerCase().replace(/\.$/, "");
      if (!host) continue;
      counts.set(host, (counts.get(host) || 0) + 1);
      if (counts.size >= max) break;
    }
  }

  BH.patterns = {
    classifyUrl: classifyUrl,
    makeGenericTarget: makeGenericTarget,
    extract: extract,
    addTarget: addTarget,
    isTakeoverCandidate: isTakeoverCandidate,
    hostFromUrl: hostFromUrl,
    extractHosts: extractHosts,
    TAKEOVER_PROVIDERS: TAKEOVER_PROVIDERS,
    RULES: RULES
  };
})();
