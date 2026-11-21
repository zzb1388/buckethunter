# BucketHunter

Firefox 扩展：自动爬取网站中引用的对象存储桶地址，被动探测「可匿名列桶 / 私有 / 桶不存在（接管候选）」，并支持可控的匿名 PUT 写入探针。

仅用于**已授权的安全测试**。

---

## 功能特性

- **自动爬取**
  - 页面 DOM、`performance` 资源计时（可捕获 webpack 动态 chunk）、内联脚本
  - 同源与跨域 JS 文件、sourcemap
  - **webpack 懒加载 chunk 枚举**：识别 `o.p + "static/js/" + id + ".js"` 模板后，自动抓取未加载的路由 chunk
  - 页面内容脚本不可用时，后台直接抓取 HTML 兜底
- **多云端点识别**
  - AWS S3、阿里云 OSS、腾讯云 COS、华为云 OBS、Google GCS、Azure Blob、Cloudflare R2、DigitalOcean Spaces、Backblaze B2、金山 KS3、百度 BOS、UCloud UFile、又拍云、七牛
  - 自定义 CDN 域名可通过 DoH 解析 CNAME 定位真实桶
- **被动探测（只读）**
  - `GET /?list-type=2&max-keys=10`
  - `GET /?prefix=&max-keys=10`
  - `HEAD /`
  - 自动跟随 S3 区域重定向
  - 依据响应头识别云厂商
- **写入探针（可控）**
  - 手动对目标发送匿名 `PUT`，只写入唯一随机文件 `bh-probe-<uuid>.txt`
  - **绝不 DELETE、绝不覆盖已有对象**
  - 写入成功后回读验证是否可公开读取
- **结果管理**
  - `storage.local` 持久化，重启浏览器不丢
  - 按当前页 / 全部历史过滤
  - 勾选清除、全部清除
  - 导出 Markdown / JSON

---

## 安装

> 仅支持 Firefox（Manifest V2，Firefox 115+）。Chrome 不支持。

### 方式一：临时加载（推荐，开发/自用）

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点击「临时载入附加组件」
3. 选择本目录下的 `manifest.json`

临时扩展在浏览器重启后失效，需要重新载入。

### 方式二：打包

```bash
npx web-ext build --source-dir .
```

生成 `web-ext-artifacts/*.zip`，改后缀为 `.xpi` 后可自行安装。Firefox 正式版要求签名，未签名安装需使用 Developer Edition / Nightly 并关闭 `xpinstall.signatures.required`。

---

## 使用

1. 打开目标页面
2. 扩展会在页面加载完成后**自动扫描当前页**（默认开启）
3. 或点击工具栏 BucketHunter 图标，手动点「扫描当前页」
4. 进度条显示各阶段计数：

```
完成:命中 2 · 帧 1 · JS 10/10 · Chunk 164/184 · 候选 2 · CNAME桶 0
```

5. 在结果表中查看目标，可按「可列桶 / 可写 / 接管候选 / 私有 / 未知」筛选
6. 需要验证写入能力时，点目标行的「PUT」按钮；扩展会写入随机探针文件并回读确认
7. 「导出 MD / JSON」生成测试记录，「清除选中 / 全部清除」只删除本地记录

### 自动扫描规则

- 触发时机：页面加载完成、切换标签页、浏览器启动、打开插件弹窗
- 去重维度：`协议 + 域名 + 路径`（忽略 hash）
- **同一网址 24 小时内只自动扫描一次**，记录持久化，重载扩展后仍生效
- 手动「扫描当前页」不受限制
- 可在设置中关闭自动扫描

### 手动探测

顶部的输入框可探测任意 URL、域名或桶地址，适合：

- 自定义 CNAME 域名
- 不在页面中出现、但已知的桶域名
- 疑似悬空 CNAME

---

## 状态说明

| 状态                         | 含义                                            |
| ---------------------------- | ----------------------------------------------- |
| 可列桶（PUBLIC_LIST）        | `200` 且返回 `ListBucketResult`，可匿名列举对象 |
| 存在·私有（PRIVATE）         | `403 AccessDenied`，桶存在但拒绝匿名访问        |
| 不存在·可接管?（NOT_EXISTS） | `404 NoSuchBucket`，桶名可能可抢注              |
| 非桶（NOT_BUCKET）           | 返回 HTML 或名称非法，不是存储桶端点            |
| 未知（UNKNOWN）              | 无标准错误码，可能被 WAF/CDN 拦截，需人工确认   |
| 请求失败（ERROR）            | 网络错误或超时                                  |

结论判定：

- 可列桶 + 可写 = 严重（可匿名列桶且可覆盖对象）
- 可列桶 = 高危
- 可写 = 高危
- NoSuchBucket + 被页面引用 = 接管候选（含 CNAME 悬空场景）

---

## 设置项

| 设置                      | 默认  | 说明                                                      |
| ------------------------- | ----- | --------------------------------------------------------- |
| 自动扫描当前页            | 开    | 页面加载 / 切换标签 / 打开插件时自动扫描，同网址 24h 去重 |
| JS 抓取上限               | 300   | 单次扫描最多抓取的 JS 文件数（含动态资源）                |
| 并发数                    | 4     | 探测并发                                                  |
| 超时 (ms)                 | 12000 | 单请求超时                                                |
| 单文件上限 (KB)           | 4096  | JS / chunk 读取上限                                       |
| Chunk 枚举上限            | 300   | webpack chunk 枚举与抓取的数量上限                        |
| 抓取 webpack 懒加载 chunk | 开    | 桶地址常只存在于未加载的路由 chunk                        |
| 扫描后自动对可列桶写探针  | 关    | 只对 PUBLIC_LIST 目标自动 PUT，不删除                     |
| 解析自定义域名 CNAME      | 开    | 通过 DoH 发现 CDN 背后的真实桶                            |

---

## 工作原理

1. 内容脚本采集页面资源、DOM、内联脚本和 `performance` 资源条目
2. 后台抓取 JS 与 sourcemap，识别 webpack 运行时并枚举懒加载 chunk
3. 用正则提取所有 URL，按云厂商端点规则归类为「探测目标」
4. 对未命中的资源域名通过 DoH（阿里 / 腾讯 / Cloudflare / Google，按顺序回退）解析 CNAME
5. 对每个目标发送只读请求，解析 XML 错误码与响应头
6. 结果按 `provider + host + bucket + container` 去重后持久化
7. 用户手动触发写入探针时，PUT 唯一随机键并回读验证

---

## 权限说明

| 权限         | 用途                                   |
| ------------ | -------------------------------------- |
| `<all_urls>` | 抓取任意站点的 JS 并探测已发现的存储桶 |
| `tabs`       | 读取当前标签页 URL、监听页面加载与切换 |
| `storage`    | 保存扫描结果与自动扫描去重记录         |
| `downloads`  | 导出 Markdown / JSON                   |

所有扫描结果仅保存在本地 `storage.local`，不会上传到任何服务器。

---

## 已知局限

- 桶地址若仅在 XHR 接口响应中下发，页面和 JS 静态内容里没有完整域名时无法发现（可用手动探测）
- 站点用反向代理把 `/files/...` 映射到桶时，客户端看不到桶域名
- DoH 在部分网络环境可能不可用（会显示 CNAME 解析失败计数）
- AWS S3 对无权限桶统一返回 403，可能掩盖「桶不存在」
- 使用哈希文件名的 webpack chunk 目前只支持数字 id 模板
- 写入探针不会自动删除，桶内会留下 `bh-probe-*.txt`，需人工清理

---

## 目录结构

```
buckethunter/
├── manifest.json
├── icons/icon.svg
└── src/
    ├── background.js      # 扫描调度、chunk 枚举、自动扫描、结果持久化
    ├── content.js         # 页面资源采集
    ├── popup.html         # 弹窗界面
    ├── popup.css
    ├── popup.js           # 结果渲染、筛选、导出、清除
    └── lib/
        ├── util.js        # 工具函数
        ├── patterns.js    # 云厂商端点规则与 URL 提取
        └── probe.js       # 列桶/接管判定、PUT 探针、DoH
```

### 开发校验

```bash
node --check src/background.js
npx web-ext lint --source-dir .
```

---

## 安全与合规

- 本工具仅用于**获得明确授权**的安全测试与自有资产检查
- 探测请求不携带 Cookie（`credentials: omit`），避免影响登录态
- 不发送 DELETE 请求，不覆盖已有对象
- 写入探针会在对方桶中留下文件，测试结束后请自行评估并清理
- 禁止用于未授权的第三方系统

---

## License

MIT
