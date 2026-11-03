# pi-web-access-local

给 Pi coding agent 的本地 web 扩展，提供两个工具：

| 工具 | 作用 |
|---|---|
| `web_search` | 通过 Exa 搜索 API（`fast` 档）取回 5 条结果的标题、URL、摘要 |
| `fetch_content` | 在本机抓取 URL 并转成 markdown（HTML 走 Defuddle/Readability，PDF 走 unpdf） |

设计目标是**快**和**省上下文**：搜索复用同一条 keep-alive 连接，结果按字节预算截断，
完整响应落盘而不是塞进上下文。

## 安装

```bash
cp -R pi-web-access-local ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions/pi-web-access-local
npm install
cp config.example.json config.json
chmod 600 config.json      # 里面有 API key
```

在 `config.json` 里填 `exaApiKey`（或改用环境变量 `EXA_API_KEY`）。然后在 Pi 里 `/reload`。

**不要**与 npm 版 `pi-web-access` 同时加载：两者注册同名工具，谁生效取决于加载顺序。

## 配置

配置文件按优先级合并：内置默认 → `~/.pi/agent/web-search.json` 的 `local` 段（可选，兼容旧版）
→ 本目录 `config.json`（最高）。两个文件都按 mtime 重新解析，改完不需要 reload。

| 字段 | 默认 | 说明 |
|---|---|---|
| `exaApiKey` | — | Exa 密钥；缺省时读环境变量 `EXA_API_KEY` |
| `exaBaseUrl` | `https://api.exa.ai` | 可用 `EXA_BASE_URL` 覆盖 |
| `numResults` | 5 | 每次搜索条数，上限 20 |
| `perResultChars` | 1200 | 单条结果摘要上限，单位是 **UTF-8 字节**（1 个汉字算 3）。上限 4000 |
| `maxTotalChars` | 8000 | 单次工具结果的总字节预算，超出部分省略并在正文说明 |
| `dedupeUrls` | true | 同一会话内重复 URL 只给标记，见下文「去重」 |
| `timeoutMs` | 8000 | 单次搜索超时，连接层失败会重试 1 次（退避 200 ms） |
| `keepAliveMs` | 60000 | 连接池空闲保留时长 |
| `warmup` | true | 会话开始时预热 DNS+TCP+TLS，省掉首次搜索的握手 |
| `defaultWorkflow` | `none` | `none` 返回原始摘要；`auto-summary` 用模型总结 |
| `spillFull` | true | 完整 JSON 落盘到 `$TMPDIR/pi-web-access-cache/`（关掉则正文只剩截断后的内容） |
| `spillMaxAgeDays` | 7 | 落盘文件保留天数，0 = 不限 |
| `spillMaxFiles` | 200 | 落盘文件个数上限，0 = 不限 |
| `spillMaxBytes` | 209715200 | 落盘总量上限（200 MB），0 = 不限 |
| `summaryModel` | — | 摘要用的模型，写成 `provider/model-id`，**必填**才能用 auto-summary |
| `summaryTimeoutMs` | 20000 | 摘要总预算，两次尝试按 60% / 40% 切分 |
| `summaryMaxChars` | 8000 | 喂给摘要模型的输入上限 |
| `summaryMaxTokens` | 2000 | 摘要输出上限；第一次只回 thinking 时会用 8000 重试 |
| `fetchMaxChars` | 20000 | 单页输出字符上限 |
| `fetchMaxBytes` | 8388608 | 单页下载字节上限（8 MiB，按解压后计算） |
| `fetchMaxPdfBytes` | 25165824 | PDF 下载上限（24 MiB） |
| `fetchTimeoutMs` | 20000 | 抓取超时；连接超时取 min(6000, 该值) |
| `fetchCaFile` | — | 额外的 CA 文件；也可直接放进 `ca/*.pem`（不提交） |
| `fetchInsecure` | false | 关掉 TLS 校验。**仅在明确知道后果时使用** |

## web_search

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | 单个查询 |
| `queries` | string[] | 多角度并发，最多 6 条，同时跑 3 条 |
| `numResults` | 1–20 | 默认取配置 |
| `recencyFilter` | `day`/`week`/`month`/`year` | 转成 Exa 的 `startPublishedDate` |
| `domainFilter` | string[] | 前缀 `-` 表示排除 |
| `category` | string | Exa 的 category，例如 `news` |
| `workflow` | `none`/`auto-summary` | 覆盖 `defaultWorkflow` |

输出格式（每条结果）：

```
## 1. 标题
URL: https://...
Published: 2026-11-03
摘要正文，最多 perResultChars 字节
```

多 query 时每段前面加 `### Query: <query>`。结果末尾附全量 JSON 的落盘路径。

### 去重

同一个会话里，某个 URL 的正文已经交付给模型之后，再遇到它只输出：

```
## N. 标题
URL: ...
(shown earlier in this session; re-fetch with fetch_content only if you no longer have it)
```

规则细节：

- 只有**之前调用**交付过的 URL 才会被标记；同一次调用内多个 query 命中同一 URL，两处都保留正文。
- 某条 query 的全部 URL 都已交付过，则**整条恢复完整正文**，不会只剩一堆标记。
- `session_start`、`session_compact`、`session_tree` 都会清空这个集合——压缩把正文从上下文摘掉之后，不再算「已看过」。

### auto-summary

`workflow: "auto-summary"` 时会用 `summaryModel` 指定的模型把结果压成 100 词以内的要点 + 3 条来源。
模型通过 `ctx.modelRegistry` 解析，凭据由 Pi 自己的 `auth.json` 提供，本扩展不存模型密钥。

- 摘要模型**不跟随主模型**，只认 `summaryModel`；没配或找不到会直接报错，不会静默退回主模型。
- 第一次尝试用 `summaryMaxTokens`，若只回了 thinking 没有正文，会用 8000 token 重试一次。
- 失败时正文退回原始摘要，并附上原因，例如
  `_auto-summary failed: primary: no text (parts: thinking, 2000/2000 output tokens); ...`
- 摘要成功时原始摘要不会进上下文，也不会把那些 URL 标记成「已交付」。

## fetch_content

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string | 单个 URL |
| `urls` | string[] | 最多 5 条，并发 3 |
| `maxChars` | ≥500 | 覆盖 `fetchMaxChars` |

行为：

- 只接受 `http:`/`https:`，跟随重定向（undici 自带 20 跳上限）。
- HTML 依次尝试 Defuddle → Readability，再用 turndown 转 markdown，保留标题层级、代码块、表格。
- 纯文本 / JSON 原样返回；PDF 用 unpdf 抽文字层，超过 300 页或抽不出文字会报错。
- 响应按解压后的字节计数截断，gzip 炸弹挡得住。
- 编码按 `content-type` 的 charset → `<meta charset>` → utf-8 依次尝试，GBK 页面不会乱码。
- TLS 信任根 = Node 内置根 + `ca/*.pem` + `fetchCaFile`。本机有 TLS 代理（例如企业代理、加速工具）时，
  把它的根证书导成 PEM 放进 `ca/`，否则 Node 会报 `SELF_SIGNED_CERT_IN_CHAIN`（curl 能通不代表 Node 能通，
  Node 用自己的内置根，不读系统钥匙串）。
- 截断时完整内容落盘，正文里给路径。

## 落盘与清理

完整搜索结果和超长页面写进 `$TMPDIR/pi-web-access-cache/<sha1前12位>.json`，权限 `0600`。
每次 `session_start` 触发一次清理（同进程 10 分钟内只扫一次），按最旧优先删除：

1. 超过 `spillMaxAgeDays` 天的；
2. 再按数量保留最新的 `spillMaxFiles` 个；
3. 再按总体积删到 `spillMaxBytes` 以内。

任何一步失败都静默跳过，不影响工具调用。目录里非 `.json` 的文件不动。

## 已知限制

- **不执行 JavaScript**：SPA、需要 XHR 才有内容的页面抓不到正文。
- **PDF 只抽文字层**：扫描件需要 OCR，这里没有。
- **不拦内网地址**：能抓内网/登录态页面是设计目标，代价是 prompt injection 理论上可以诱导抓内网资源。
  云厂商 metadata 地址（`169.254.169.254` 等）目前也没有硬拦，介意的话自行加白/黑名单。
- **没有 in-flight 合并**：同一 query 并发两次会打两次 API（重复 query 靠 Exa 服务端缓存，300–600 ms 命中）。
- **`fetch_content` 没有总量预算**：`maxChars` 是单页上限，5 页叠加仍可能到 100 KB。
- 去重集合只在进程内存里，重启后归零。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `Error: no Exa API key` | `config.json` 的 `exaApiKey` 为空，或没设 `EXA_API_KEY` |
| `Exa API 401/403` | 密钥无效或额度用尽 |
| `request timed out after 8000ms` | 跨境链路慢；可调 `timeoutMs`，注意会连同重试一起变慢 |
| `fetch failed (SELF_SIGNED_CERT_IN_CHAIN)` | 缺本地 CA，见上文 TLS 说明 |
| `response exceeded the N-byte cap` | 响应过大，调 `fetchMaxBytes` 或改用别的源 |
| `HTTP 404 for ...` | 目标站点返回 404，错误信息里带响应开头 160 字符 |
| `Could not extract readable content` | JS 渲染页或被反爬拦截 |
| `local.summaryModel is not configured` | 没配摘要模型，见配置表 |
| `local.summaryModel "x" was not found in the registry` | `provider/model-id` 写错，或该 provider 未启用 |
| `streamSimple failed: ...` | 模型调用失败，原文即 provider 的报错（常见是没登录） |

## 依赖

| 包 | 用途 |
|---|---|
| `undici` | 抓取用 HTTP 客户端；需要自定义 CA 与连接池 |
| `defuddle` / `linkedom` | 首选正文抽取 |
| `@mozilla/readability` / `turndown` | 抽取兜底 + HTML 转 markdown |
| `unpdf` | PDF 文字层抽取 |

搜索路径不依赖任何第三方包，只用 `node:https`。

## 文件

| 文件 | 职责 |
|---|---|
| `index.ts` | 注册两个工具、并发调度、去重状态、压缩钩子 |
| `config.ts` | 三层配置合并 + mtime 缓存 |
| `exa.ts` | Exa 客户端：keep-alive 池、超时/重试、预热 |
| `fetch.ts` | 本地抓取、CA 合并、字节上限、编码、抽取 |
| `render.ts` | 结果转 markdown、字节截断、总预算、去重 |
| `summary.ts` | 摘要：模型解析、分段预算、错误分类 |
| `store.ts` | 落盘与自动清理 |
