# 中俄互译 · Lite

一次输入，同时生成**中文**与**俄语**译文。部署在 Cloudflare Pages 上，
上游模型为 NVIDIA NIM 的 `nvidia/nemotron-3-ultra-550b-a55b`。

API Key 只存在于服务端环境变量中，浏览器不会接触到它。

## 部署到 Cloudflare Pages

1. 将本仓库推送到你自己的 GitHub 仓库。
2. 在 Cloudflare Pages 中连接该仓库，设置：
   - Build command：留空
   - Build output directory：`public`
   - Root directory：留空
3. 部署完成后，进入 **Settings → Variables and Secrets → Production**，添加：
   - `NVIDIA_API_KEY`：你的 NVIDIA NIM API Key（类型选择 **Secret**）
4. （可选）创建 KV Namespace，绑定变量 `RATE_LIMIT_KV`，启用跨 isolate 的分布式限流。
5. 重新部署，打开 Pages 提供的域名即可使用。

## 使用

- 输入或粘贴文本，**停止输入 0.75 秒**后自动翻译，也可以点「翻译」按钮。
- 单次最多 **20,000 字符**（输入框已限制，超出会被浏览器截断）。
- 点击译文卡片或「复制」按钮可复制对应语言的译文。
- 右上角按钮切换亮/暗主题，偏好保存在 `localStorage`。

## 本地开发

需要 Node.js 18+。

```bash
npm i -D wrangler

# 本地密钥，不要提交到 Git（已在 .gitignore 中）
echo 'NVIDIA_API_KEY=nvapi-xxxxxxxx' > .dev.vars

npx wrangler pages dev ./public --port 8787
# 打开 http://127.0.0.1:8787
```

想用本地假的上游做联调（不消耗真实额度），可以把
`functions/api/translate.js` 里的 `https://integrate.api.nvidia.com/v1/chat/completions`
临时指向一个返回 SSE 流的本地服务。

## 环境变量

在 `wrangler.toml` 的 `[vars]` 中修改，或在 Dashboard 里覆盖。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NVIDIA_API_KEY` | — | **必填**，NVIDIA NIM API Key，只能配成 Secret |
| `MODEL` | `nvidia/nemotron-3-ultra-550b-a55b` | 上游模型 ID |
| `TIMEOUT_MS` | `60000` | 上游请求超时（服务端） |
| `MAX_SOURCE_LENGTH` | `20000` | 原文最大字符数 |
| `MAX_REQUEST_BYTES` | `100000` | 请求体最大字节数 |
| `MIN_INTERVAL_MS` | `4800` | 前端两次请求的最小间隔，由 `/api/health` 下发 |
| `RATE_LIMIT_MAX` | `15` | 每个 IP 在窗口内的最大请求数 |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | 限流窗口长度 |
| `CACHE_MAX` | `200` | 译文缓存最多条数 |
| `CACHE_MAX_TEXT_LENGTH` | `4000` | 超过此长度的原文不走缓存 |

## API

### `POST /api/translate`

```http
POST /api/translate
Content-Type: application/json

{ "text": "要翻译的原文" }
```

成功：

```json
{ "zh": "…", "ru": "…" }
```

失败：

```json
{ "error": { "message": "人类可读的中文提示", "code": "TEXT_TOO_LONG" } }
```

| code | HTTP | 含义 |
| --- | --- | --- |
| `METHOD_ERR` | 405 | 只支持 POST |
| `INVALID_CONTENT_TYPE` | 415 | Content-Type 必须是 `application/json` |
| `FORBIDDEN` | 403 | 跨站调用（`Origin` 与本站不符） |
| `INVALID_JSON` | 400 | 请求体不是含 `text` 字段的 JSON |
| `EMPTY_TEXT` | 400 | 原文为空 |
| `TEXT_TOO_LONG` | 413 | 原文超过 `MAX_SOURCE_LENGTH` |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超过 `MAX_REQUEST_BYTES` |
| `NO_KEY` | 503 | 服务端未配置 `NVIDIA_API_KEY` |
| `KEY_INVALID` | 401 | 上游拒绝了 API Key |
| `RATE_LIMITED` | 429 | 超出限流配额，带 `Retry-After` 头 |
| `TIMEOUT` | 504 | 上游超时 |
| `PARSE_ERROR` | 502 | 模型返回的不是可解析的 JSON |
| `UPSTREAM_ERR` | 502 | 上游其他异常 |
| `CIRCUIT_OPEN` | 503 | 熔断器打开，暂时拒绝请求 |

所有 JSON 响应都带 `x-translator-proxy: 1` 头。前端用它区分「函数没部署」
（Pages 会返回静态首页，没有这个头）和「函数报错」。

### `GET /api/health`

```json
{ "ok": true, "minIntervalMs": 4800 }
```

未配置 `NVIDIA_API_KEY` 时返回 503 + `{ "ok": false, "error": { "code": "NO_KEY" } }`。
前端读取 `minIntervalMs` 来设置本地的请求节流间隔。

## 服务端处理流程

```
① 方法 / Content-Type / Origin 校验
② 按 IP 限流（KV 或 isolate 内存）
③ 读 body（逐块累加，超限立即中断）、校验原文长度
④ 查缓存 → 查在途去重表
⑤ 过熔断器 → 请求 NVIDIA（SSE 流式）
⑥ 拼流、抽 JSON、校验 zh/ru 字段
```

- **缓存**：isolate 内存级 LRU，TTL 5 分钟，最多 200 条，只对 ≤4000 字符的原文生效。
  同一 isolate 内命中，跨 isolate 不共享。
- **去重**：相同原文的并发请求会合并成一次上游调用。
- **熔断**：连续 5 次失败后打开 30 秒。`KEY_INVALID` 和 `RATE_LIMITED` 不计入失败。
- **限流**：绑定 `RATE_LIMIT_KV` 时用 KV 计数（跨 isolate 生效，但每次放行会产生
  1 次读 + 1 次写，免费额度为 1000 次写/天）；否则退化为 isolate 内存计数。

## 排查

在 Cloudflare 的 **Pages Functions Logs** 中查看运行日志，日志是结构化 JSON，
带 `service`、`event`、`requestId`、`durationMs` 字段。
