(function () {
  const BH = window.BH;
  const U = BH.util;

  const EVIDENCE_HEADERS = [
    "content-type", "server", "location", "via",
    "x-amz-request-id", "x-amz-id-2", "x-amz-bucket-region",
    "x-oss-request-id", "x-oss-server-time",
    "x-cos-request-id", "x-cos-trace-id",
    "x-obs-request-id", "x-obs-id-2",
    "x-goog-generation", "x-goog-metageneration", "x-guploader-uploadid",
    "x-ms-request-id", "x-ms-version",
    "x-kss-request-id", "cf-ray"
  ];

  function pickHeaders(headers) {
    const out = {};
    EVIDENCE_HEADERS.forEach(function (k) {
      if (headers && headers[k]) out[k] = headers[k];
    });
    return out;
  }

  function detectProvider(headers) {
    const h = headers || {};
    const server = String(h["server"] || "");
    if (h["x-amz-request-id"] || h["x-amz-id-2"] || h["x-amz-bucket-region"] || /amazons3/i.test(server)) return "AWS S3";
    if (h["x-oss-request-id"] || /aliyunoss/i.test(server)) return "Aliyun OSS";
    if (h["x-cos-request-id"] || h["x-cos-trace-id"] || /tencent-cos/i.test(server)) return "Tencent COS";
    if (h["x-obs-request-id"] || /^obs$/i.test(server)) return "Huawei OBS";
    if (h["x-goog-generation"] || h["x-goog-metageneration"] || h["x-guploader-uploadid"]) return "Google GCS";
    if (h["x-ms-request-id"] && (h["x-ms-version"] || /windows-azure-blob/i.test(server))) return "Azure Blob";
    if (h["x-kss-request-id"] || /kingsoft/i.test(server)) return "Kingsoft KS3";
    return "";
  }

  async function readLimited(res, limit) {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (total < limit) {
        const step = await reader.read();
        if (step.done) break;
        let value = step.value;
        if (value.length > limit - total) value = value.subarray(0, limit - total);
        chunks.push(value);
        total += value.length;
        if (total >= limit) break;
      }
    } catch (e) { /* 读取中断按已读内容处理 */ }
    try { reader.cancel(); } catch (e) { /* ignore */ }
    const merged = new Uint8Array(total);
    let offset = 0;
    chunks.forEach(function (chunk) {
      merged.set(chunk, offset);
      offset += chunk.length;
    });
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
  }

  async function fetchSafe(url, options) {
    const opts = options || {};
    const method = opts.method || "GET";
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, opts.timeout || 12000);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: method,
        headers: opts.headers || {},
        body: opts.body,
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      const headers = U.headersToObject(res.headers);
      let body = "";
      if (method !== "HEAD") {
        body = await readLimited(res, opts.maxBody || 65536);
      }
      return {
        ok: true, status: res.status, headers: headers, body: body,
        finalUrl: res.url || url, elapsed: Date.now() - started
      };
    } catch (err) {
      return {
        ok: false, status: 0, headers: {}, body: "",
        error: String((err && err.message) || err), elapsed: Date.now() - started
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function buildRequests(target) {
    const reqs = [];
    const base = target.baseUrl.replace(/\/+$/, "");

    if (target.style === "azure") {
      reqs.push({ method: "GET", url: base + "?restype=container&comp=list&maxresults=5" });
      reqs.push({ method: "GET", url: base + "?comp=list&restype=container" });
      reqs.push({ method: "HEAD", url: base });
      return reqs;
    }

    reqs.push({ method: "GET", url: base + "/?list-type=2&max-keys=10&encoding-type=url" });
    reqs.push({ method: "GET", url: base + "/?prefix=&max-keys=10" });

    if (target.style === "virtual" || target.style === "url") {
      reqs.push({ method: "GET", url: base + "/" });
    } else {
      reqs.push({ method: "HEAD", url: base + "/" });
    }

    if (target.provider === "AWS S3" && target.style === "virtual" && target.bucket.indexOf(".") !== -1) {
      reqs.push({ method: "GET", url: "https://s3.amazonaws.com/" + encodeURIComponent(target.bucket) + "/?list-type=2&max-keys=10" });
    }
    return reqs;
  }

  function analyze(target, res, req) {
    const base = {
      status: "UNKNOWN",
      requestUrl: req.url,
      requestMethod: req.method,
      checkedAt: U.nowISO(),
      httpStatus: res.status,
      elapsed: res.elapsed,
      headers: pickHeaders(res.headers),
      contentType: String(res.headers["content-type"] || ""),
      server: String(res.headers["server"] || ""),
      providerHint: detectProvider(res.headers),
      region: String(res.headers["x-amz-bucket-region"] || ""),
      code: "",
      message: "",
      bodySnippet: "",
      error: ""
    };
    if (!res.ok) {
      base.status = "ERROR";
      base.error = res.error || "请求失败";
      return base;
    }

    const body = res.body || "";
    base.bodySnippet = U.truncate(body.replace(/\s+/g, " ").trim(), 1800);

    const codeMatch = body.match(/<Code>\s*([^<]+?)\s*<\/Code>/i);
    const msgMatch = body.match(/<Message>\s*([^<]*?)\s*<\/Message>/i);
    if (codeMatch) base.code = codeMatch[1];
    if (msgMatch) base.message = msgMatch[1];
    if (!base.code) {
      const jsonCode = body.match(/"code"\s*:\s*"([A-Za-z]+)"/);
      if (jsonCode) base.code = jsonCode[1];
    }

    if (/<ListBucketResult[\s>]/i.test(body) || /<ListVersionsResult[\s>]/i.test(body) || /<EnumerationResults[\s>]/i.test(body)) {
      base.status = "PUBLIC_LIST";
      return base;
    }
    if (/<ListAllMyBucketsResult[\s>]/i.test(body)) {
      base.status = "PUBLIC_LIST";
      base.accountList = true;
      return base;
    }

    if (/NoSuchBucket/i.test(base.code) || /NoSuchBucket/i.test(body)) {
      base.status = "NOT_EXISTS";
      return base;
    }
    if (/ContainerNotFound|ResourceNotFound/i.test(base.code)) {
      base.status = "NOT_EXISTS";
      base.azureMissing = true;
      return base;
    }
    if (/InvalidBucketName|SecondLevelDomainForbidden|InvalidArgument/i.test(base.code)) {
      base.status = "NOT_BUCKET";
      return base;
    }

    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      base.status = "REDIRECT";
      base.location = String(res.headers["location"] || "");
      if (!base.region) {
        const m = /[.-](?:s3|oss|obs)[.-]([a-z0-9-]+)\./i.exec(base.location);
        if (m) base.region = m[1];
      }
      return base;
    }

    if (res.status === 401 || res.status === 403) {
      const looksStorage = !!base.providerHint ||
        /AccessDenied|AllAccessDisabled|Forbidden|SignatureDoesNotMatch|InvalidAccessKeyId/i.test(base.code + " " + body);
      base.status = looksStorage ? "PRIVATE" : "UNKNOWN";
      if (!looksStorage) base.note = "403 但无存储厂商特征,可能被 WAF/CDN 拦截";
      return base;
    }

    if (res.status === 404) {
      if (/specified bucket does not exist|NoSuchBucket/i.test(body)) {
        base.status = "NOT_EXISTS";
        return base;
      }
      base.status = "UNKNOWN";
      base.note = "404 且无标准错误码,可能是 CDN 兜底页";
      return base;
    }

    if (res.status >= 200 && res.status < 300) {
      if (/text\/html/i.test(base.contentType)) {
        base.status = "NOT_BUCKET";
        return base;
      }
      if (/AccessDenied/i.test(body)) {
        base.status = "PRIVATE";
        return base;
      }
      base.status = "UNKNOWN";
      return base;
    }

    return base;
  }

  const CONCLUSIVE = new Set(["PUBLIC_LIST", "PRIVATE", "NOT_EXISTS", "NOT_BUCKET"]);
  const RANK = { PUBLIC_LIST: 6, PRIVATE: 5, NOT_EXISTS: 4, NOT_BUCKET: 3, REDIRECT: 2, UNKNOWN: 1, ERROR: 0 };

  function conclusive(status) {
    return CONCLUSIVE.has(status);
  }

  async function probeTarget(target) {
    const reqs = buildRequests(target);
    let best = null;

    for (let i = 0; i < reqs.length; i++) {
      const req = reqs[i];
      const res = await fetchSafe(req.url, { method: req.method, timeout: 12000, maxBody: 65536 });
      const det = analyze(target, res, req);
      if (!best || (RANK[det.status] || 0) > (RANK[best.status] || 0)) best = det;

      if (det.status === "REDIRECT" && det.region && target.provider === "AWS S3" && target.style === "virtual") {
        const newHost = target.host.replace(/s3(?:[.-][a-z0-9-]+)?\.amazonaws/, "s3." + det.region + ".amazonaws");
        if (newHost !== target.host) {
          const retryTarget = Object.assign({}, target, { host: newHost, baseUrl: "https://" + newHost, region: det.region });
          const retryReqs = buildRequests(retryTarget);
          for (let j = 0; j < retryReqs.length; j++) {
            const r2 = retryReqs[j];
            const res2 = await fetchSafe(r2.url, { method: r2.method, timeout: 12000, maxBody: 65536 });
            const d2 = analyze(retryTarget, res2, r2);
            if (conclusive(d2.status)) {
              d2.region = d2.region || det.region;
              d2.note = "经 S3 区域重定向重试";
              return d2;
            }
          }
        }
      }

      if (conclusive(det.status)) break;
    }

    return best || {
      status: "ERROR", error: "没有可用的探测请求", requestUrl: "", requestMethod: "",
      checkedAt: U.nowISO(), httpStatus: 0, headers: {}, code: "", message: "",
      bodySnippet: "", contentType: "", providerHint: "", region: ""
    };
  }

  // 匿名写入探针:写唯一随机键,绝不删除任何内容
  async function writeProbe(target) {
    const id = U.uuid();
    const keyName = "bh-probe-" + id + ".txt";
    const base = target.baseUrl.replace(/\/+$/, "");
    const probeUrl = base + "/" + keyName;
    const payload = "BucketHunter anonymous write probe\nid=" + id + "\ntime=" + U.nowISO() + "\n";

    const headers = { "Content-Type": "text/plain; charset=utf-8" };
    if (target.style === "azure") headers["x-ms-blob-type"] = "BlockBlob";

    const res = await fetchSafe(probeUrl, {
      method: "PUT", headers: headers, body: payload, timeout: 15000, maxBody: 16384
    });

    const out = {
      result: "failed",
      key: keyName,
      probeUrl: probeUrl,
      checkedAt: U.nowISO(),
      httpStatus: res.ok ? res.status : 0,
      headers: pickHeaders(res.headers),
      snippet: U.truncate(res.body || "", 1200),
      error: res.ok ? "" : (res.error || ""),
      deleted: false
    };

    if (!res.ok) {
      out.result = "error";
      return out;
    }
    if (res.status >= 200 && res.status < 300) {
      out.result = "writable";
      const readback = await fetchSafe(probeUrl, { method: "GET", timeout: 12000, maxBody: 8192 });
      out.readback = {
        httpStatus: readback.ok ? readback.status : 0,
        public: !!(readback.ok && readback.status === 200 && String(readback.body || "").indexOf(id) !== -1)
      };
    } else if (res.status === 401 || res.status === 403 || res.status === 405) {
      out.result = "denied";
    }
    return out;
  }

  // DoH 解析自定义域名的 CNAME,用于发现 CDN 背后的真实桶(multi-cloud, 国内可用端点优先)
  const DOH_ENDPOINTS = [
    function (h) { return "https://dns.alidns.com/resolve?name=" + encodeURIComponent(h) + "&type=CNAME"; },
    function (h) { return "https://doh.pub/dns-query?name=" + encodeURIComponent(h) + "&type=CNAME"; },
    function (h) { return "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(h) + "&type=CNAME"; },
    function (h) { return "https://dns.google/resolve?name=" + encodeURIComponent(h) + "&type=CNAME"; }
  ];
  const cnameCache = new Map();

  async function resolveCname(host) {
    const key = String(host || "").toLowerCase();
    if (!key) return { answers: [], error: "空域名", endpoint: "" };
    if (cnameCache.has(key)) return cnameCache.get(key);

    let out = { answers: [], error: "", endpoint: "" };
    for (let i = 0; i < DOH_ENDPOINTS.length; i++) {
      const url = DOH_ENDPOINTS[i](key);
      const res = await fetchSafe(url, {
        headers: { "Accept": "application/dns-json" },
        timeout: 6000,
        maxBody: 32768
      });
      if (!res.ok || res.status !== 200) continue;
      let json = null;
      try { json = JSON.parse(res.body); } catch (e) { continue; }
      const answers = (Array.isArray(json.Answer) ? json.Answer : [])
        .filter(function (a) { return a && (a.type === 5 || a.type === "CNAME"); })
        .map(function (a) { return String(a.data || "").replace(/\.$/, "").toLowerCase(); })
        .filter(Boolean);
      out = { answers: answers, error: "", endpoint: url };
      break;
    }
    if (!out.endpoint) out.error = "DoH 全部失败(可能被网络拦截)";
    cnameCache.set(key, out);
    return out;
  }

  BH.probe = {
    fetchSafe: fetchSafe,
    probeTarget: probeTarget,
    writeProbe: writeProbe,
    buildRequests: buildRequests,
    analyze: analyze,
    detectProvider: detectProvider,
    resolveCname: resolveCname,
    pickHeaders: pickHeaders
  };
})();
