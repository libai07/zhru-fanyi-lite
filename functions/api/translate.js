// src/backend/lib/config.ts
const CONFIG = {
  MODEL: "nvidia/nemotron-3-ultra-550b-a55b",
  TIMEOUT_MS: 60000,
  MAX_SOURCE_LENGTH: 20000,
  MAX_REQUEST_BYTES: 100000,
  MIN_INTERVAL_MS: 4800,
  CACHE_TTL_MS: 5 * 60 * 1000,
  CACHE_MAX: 200,
  CACHE_MAX_TEXT_LENGTH: 4000,
  RATE_LIMIT_WINDOW_MS: 60000,
  RATE_LIMIT_MAX_REQUESTS: 15,
  UPSTREAM: {
    temperature: 0.2,
    top_p: 0.95,
    max_tokens: 16384,
  },
};

function getKey(env) {
  const key = (env.NVIDIA_API_KEY ?? "").trim();
  if (!key) throw Object.assign(new Error("NO_KEY"), { code: "NO_KEY" });
  return key;
}

function getConfig(env) {
  return {
    model: (env.MODEL ?? "").trim() || CONFIG.MODEL,
    timeoutMs: clampInt(env.TIMEOUT_MS, CONFIG.TIMEOUT_MS, 1000, 180000),
    maxSourceLength: clampInt(env.MAX_SOURCE_LENGTH, CONFIG.MAX_SOURCE_LENGTH, 1, 100000),
    maxRequestBytes: clampInt(env.MAX_REQUEST_BYTES, CONFIG.MAX_REQUEST_BYTES, 1024, 1000000),
    minIntervalMs: clampInt(env.MIN_INTERVAL_MS, CONFIG.MIN_INTERVAL_MS, 0, 60000),
    cacheTtlMs: CONFIG.CACHE_TTL_MS,
    cacheMax: clampInt(env.CACHE_MAX, CONFIG.CACHE_MAX, 1, 100000),
    cacheMaxTextLength: clampInt(env.CACHE_MAX_TEXT_LENGTH, CONFIG.CACHE_MAX_TEXT_LENGTH, 1, 100000),
    rateLimitWindowMs: clampInt(env.RATE_LIMIT_WINDOW_SECONDS, CONFIG.RATE_LIMIT_WINDOW_MS / 1000, 1, 86400) * 1000,
    rateLimitMaxRequests: clampInt(env.RATE_LIMIT_MAX, CONFIG.RATE_LIMIT_MAX_REQUESTS, 1, 100000),
  };
}

function clampInt(val, def, min, max) {
  if (val === undefined || val === "") return def;
  const n = Number(val);
  return Number.isSafeInteger(n) ? Math.min(max, Math.max(min, n)) : def;
}

// src/backend/lib/prompt.ts
const SYSTEM_PROMPT = `You are a senior native-level translator for two target locales:
- zh: Simplified Chinese (PRC), GB/T standard
- ru: Russian (RF), GOST standard

Return ONLY a valid JSON object with exactly these string keys: "zh", "ru".
No markdown, reasoning, explanation, or filler outside the JSON.

HARD CONSTRAINTS (violation = invalid output):
1. If source language == target language → copy source UNCHANGED for that target field.
2. Preserve formatting BYTE-LEVEL: code fences, markdown tables, LaTeX ($$...$$), line breaks, indentation, whitespace, zero-width chars.
3. UNTRANSLATABLES (copy verbatim): proper nouns, brands, acronyms, numbers+units, emails, URLs, paths, code identifiers, hashes, CLI commands, regex, markup keys, templating syntax.
4. Output ONLY the JSON object. No extra keys, no comments, no trailing commas.

QUALITY STANDARDS:
- Native grammar, register, idioms — ZERO translationese
- Domain terminology accuracy: legal, medical, tech, finance, marketing, academic
- Cultural localization: PRC (GB/T), RF (GOST)
- Stylistic fidelity: preserve voice, irony, hedging, formality, rhetorical devices
- No omission, no hallucination, no over-translation

OUTPUT SPEC:
{
  "zh": "Simplified Chinese, PRC norm",
  "ru": "Russian, RF norm"
}`;

const BRIEF_TEMPLATE = `Apply full senior translator decision framework to the source text below.

DOMAIN AUTO-DETECT (apply relevant conventions):
- Legal: "whereas", "hereby", "shall", "pursuant to", "force majeure" → formal register, precise terminology
- Medical: ICD codes, drug names, "adverse event", "contraindication" → clinical precision, Latin terms preserved
- Tech: API, endpoint, latency, stack trace, CI/CD, k8s, Terraform → developer idioms, English terms kept where standard
- Finance: SWIFT, ISIN, basis points, EBITDA, derivatives → market-standard terminology
- Marketing: CTA, hook, brand voice, transcreation flag → persuasive, culturally adapted
- Academic: citation style, passive/active balance, hedging → scholarly register

UNTRANSLATABLES (verbatim): proper nouns, brands, acronyms, numbers+units, emails, URLs, paths, code identifiers, hashes, CLI, regex, markup keys.

FORMAT PRESERVATION (byte-level): code fences, markdown tables, LaTeX ($$), line breaks, indentation, whitespace.

OUTPUT: ONLY JSON {"zh":"…","ru":"…"}

SOURCE TEXT:
{text}`;

function buildPrompt(text) {
  return BRIEF_TEMPLATE.replace("{text}", text);
}

// src/backend/lib/nvidia.ts
async function callNvidia(key, model, text, timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(text) },
      ],
      temperature: CONFIG.UPSTREAM.temperature,
      top_p: CONFIG.UPSTREAM.top_p,
      max_tokens: CONFIG.UPSTREAM.max_tokens,
      stream: true,
    }),
    signal: combinedSignal,
  });

  return res;
}

async function parseNvidiaStream(res) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string") fullContent += delta;
        } catch {
          // ignore parse errors in stream
        }
      }
    }
    // process remaining buffer
    if (buffer.trim()) {
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string") fullContent += delta;
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
  return fullContent;
}

// src/backend/lib/parse.ts
const LANGS = ["zh", "ru"];

function validateTranslation(obj) {
  if (!obj || typeof obj !== "object") throw new Error("PARSE_ERROR");
  for (const key of LANGS) {
    const val = obj[key];
    if (typeof val !== "string" || !val.trim()) throw new Error("PARSE_ERROR");
  }
  return { zh: obj.zh.trim(), ru: obj.ru.trim() };
}

function extractJson(text) {
  // Fast path: the whole payload is already the object we want.
  // NOTE: a successful direct parse is NOT sufficient — the model may hand back a
  // well-formed *wrapper* such as {"result":{"zh":…}}, which parses fine but has
  // no language keys at the top level. Only accept it if it really carries them.
  try {
    const parsed = JSON.parse(text);
    if (parsed && LANGS.every((k) => parsed[k])) return parsed;
  } catch {}
  // Fallback: scan for balanced {...} candidates, innermost first, and return the
  // first one that actually carries every language key. This handles wrappers,
  // ```json fences, leading prose, and reasoning text around the payload.
  const braceStack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") braceStack.push(i);
    else if (ch === "}") {
      const start = braceStack.pop();
      if (start === undefined) continue;
      const candidate = text.slice(start, i + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (LANGS.every((k) => parsed && parsed[k])) return parsed;
      } catch {}
    }
  }
  throw new Error("PARSE_ERROR");
}

function parseTranslations(raw) {
  const parsed = extractJson(raw);
  return validateTranslation(parsed);
}

// src/backend/lib/errors.ts
const MESSAGES = {
  NO_KEY: "服务端未配置 NVIDIA_API_KEY",
  INVALID_CONTENT_TYPE: "Content-Type 必须是 application/json",
  FORBIDDEN: "不允许跨站调用",
  INVALID_JSON: "请求体必须是包含 text 字段的 JSON",
  EMPTY_TEXT: "请输入需要翻译的内容",
  TEXT_TOO_LONG: "原文不能超过 20000 字符",
  PAYLOAD_TOO_LARGE: "请求体过大",
  TIMEOUT: "上游请求超时",
  KEY_INVALID: "API Key 无效或已过期",
  RATE_LIMITED: "请求过于频繁",
  PARSE_ERROR: "模型返回格式错误",
  UPSTREAM_ERR: "上游服务异常",
  METHOD_ERR: "仅支持 POST",
  CIRCUIT_OPEN: "服务暂时不可用，请稍后重试",
};

const STATUS = {
  NO_KEY: 503,
  INVALID_CONTENT_TYPE: 415,
  FORBIDDEN: 403,
  INVALID_JSON: 400,
  EMPTY_TEXT: 400,
  TEXT_TOO_LONG: 413,
  PAYLOAD_TOO_LARGE: 413,
  TIMEOUT: 504,
  KEY_INVALID: 401,
  RATE_LIMITED: 429,
  PARSE_ERROR: 502,
  UPSTREAM_ERR: 502,
  METHOD_ERR: 405,
  CIRCUIT_OPEN: 503,
};

function log(level, event, fields = {}) {
  console[level](JSON.stringify({ service: "zhru-fanyi-lite", event, ...fields, ts: new Date().toISOString() }));
}

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-translator-proxy", "1");
  return Response.json(data, { ...init, headers });
}

function err(code) {
  return json(
    { error: { message: MESSAGES[code] ?? "未知错误", code } },
    { status: STATUS[code] ?? 500 }
  );
}

// src/backend/lib/circuit-breaker.ts
const CircuitState = { CLOSED: "closed", OPEN: "open", HALF_OPEN: "half_open" };

class CircuitBreaker {
  constructor(config) {
    this.config = config;
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.nextAttempt = 0;
  }

  async execute(operation, countFailure = () => true) {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) throw new Error("CIRCUIT_OPEN");
      this.state = CircuitState.HALF_OPEN;
    }
    try {
      const result = await operation();
      this.failures = 0;
      this.state = CircuitState.CLOSED;
      return result;
    } catch (error) {
      if (countFailure(error)) {
        this.failures++;
        if (this.failures >= this.config.failureThreshold) {
          this.state = CircuitState.OPEN;
          this.nextAttempt = Date.now() + this.config.resetTimeoutMs;
        }
      }
      throw error;
    }
  }

  getState() {
    return this.state;
  }

  reset() {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.nextAttempt = 0;
  }
}

let circuitBreakerInstance = null;
function getCircuitBreaker() {
  circuitBreakerInstance ??= new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 });
  return circuitBreakerInstance;
}

// src/backend/lib/deduplicator.ts
class RequestDeduplicator {
  constructor(config) {
    this.config = config;
    this.pending = new Map();
  }

  async deduplicate(key, factory) {
    const now = Date.now();
    for (const [k, v] of this.pending) {
      if (v.expires < now) this.pending.delete(k);
    }
    const existing = this.pending.get(key);
    if (existing) return existing.promise;

    const promise = Promise.resolve().then(factory).finally(() => {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
    });

    if (this.pending.size >= this.config.maxEntries) {
      // Evict the oldest entry that has already settled. Never drop a promise that
      // is still in flight: the caller holds it, and dropping it would let a second
      // upstream request slip through for the same key.
      let evicted = false;
      for (const [k, v] of this.pending) {
        if (v.settled) {
          this.pending.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) return promise; // table is full of live requests; skip caching this one
    }
    this.pending.set(key, { promise, settled: false, expires: now + this.config.ttlMs });
    promise.then(
      () => {
        const entry = this.pending.get(key);
        if (entry?.promise === promise) entry.settled = true;
      },
      () => {
        const entry = this.pending.get(key);
        if (entry?.promise === promise) entry.settled = true;
      }
    );
    return promise;
  }
}

// src/backend/lib/cache.ts
const responseCache = new Map();

async function getCacheKey(text) {
  const input = new TextEncoder().encode(`${CONFIG.MODEL}\0${text}`);
  const buf = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCached(key, ttlMs) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) {
    responseCache.delete(key);
    return null;
  }
  // LRU: move to end
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.data;
}

function setCached(key, data, maxEntries) {
  if (responseCache.size >= maxEntries) {
    const oldest = responseCache.keys().next().value;
    if (oldest) responseCache.delete(oldest);
  }
  responseCache.set(key, { data, ts: Date.now() });
}

// src/backend/lib/rate-limiter.ts (inline for KV optional)
class DistributedRateLimiter {
  constructor(kv, config) {
    this.kv = kv;
    this.config = config;
  }

  async checkLimit(identifier) {
    const key = `${this.config.keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const stored = await this.kv.get(key, "json");
    if (!stored || stored.windowStart < windowStart) {
      await this.kv.put(key, JSON.stringify({ count: 1, windowStart: now }), {
        expirationTtl: Math.ceil(this.config.windowMs / 1000) + 10,
      });
      return {
        allowed: true,
        remaining: this.config.maxRequests - 1,
        resetTime: now + this.config.windowMs,
      };
    }
    if (stored.count >= this.config.maxRequests) {
      const resetTime = stored.windowStart + this.config.windowMs;
      return {
        allowed: false,
        remaining: 0,
        resetTime,
        retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
      };
    }
    stored.count++;
    await this.kv.put(key, JSON.stringify(stored), {
      expirationTtl: Math.ceil(this.config.windowMs / 1000) + 10,
    });
    return {
      allowed: true,
      remaining: this.config.maxRequests - stored.count,
      resetTime: stored.windowStart + this.config.windowMs,
    };
  }
}

// In-memory rate limiter fallback
class MemoryRateLimiter {
  constructor(config) {
    this.config = config;
    this.store = new Map();
  }

  async checkLimit(identifier) {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const entry = this.store.get(identifier);
    if (!entry || entry.windowStart < windowStart) {
      this.store.set(identifier, { count: 1, windowStart: now });
      return { allowed: true, remaining: this.config.maxRequests - 1, resetTime: now + this.config.windowMs };
    }
    if (entry.count >= this.config.maxRequests) {
      const resetTime = entry.windowStart + this.config.windowMs;
      return { allowed: false, remaining: 0, resetTime, retryAfter: Math.ceil((resetTime - now) / 1000) };
    }
    entry.count++;
    return { allowed: true, remaining: this.config.maxRequests - entry.count, resetTime: entry.windowStart + this.config.windowMs };
  }
}

// src/backend/api/translate.ts
const deduplicator = new RequestDeduplicator({ ttlMs: 120000, maxEntries: 1000 });

async function readBodyWithLimit(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_JSON");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function handleRequest({ request, env }) {
  const started = Date.now();
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();

  if (request.method !== "POST") return err("METHOD_ERR");
  if ((request.headers.get("content-type")?.split(";")[0]?.trim() ?? "") !== "application/json") {
    return err("INVALID_CONTENT_TYPE");
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return err("FORBIDDEN");

  let key;
  try {
    key = getKey(env);
  } catch (e) {
    const code = e.code;
    if (code) return err(code);
    throw e;
  }

  const cfg = getConfig(env);

  // Rate limiting
  if (env.RATE_LIMIT_KV) {
    const rateLimiter = new DistributedRateLimiter(env.RATE_LIMIT_KV, {
      windowMs: cfg.rateLimitWindowMs,
      maxRequests: cfg.rateLimitMaxRequests,
      keyPrefix: "ratelimit",
    });
    const result = await rateLimiter.checkLimit(request.headers.get("cf-connecting-ip") ?? "unknown");
    if (!result.allowed) {
      const response = err("RATE_LIMITED");
      if (result.retryAfter) response.headers.set("Retry-After", String(result.retryAfter));
      return response;
    }
  } else {
    // In-memory fallback (per isolate)
    if (!globalThis.__rateLimiter) globalThis.__rateLimiter = new MemoryRateLimiter({
      windowMs: cfg.rateLimitWindowMs,
      maxRequests: cfg.rateLimitMaxRequests,
    });
    const result = await globalThis.__rateLimiter.checkLimit(request.headers.get("cf-connecting-ip") ?? "unknown");
    if (!result.allowed) {
      const response = err("RATE_LIMITED");
      if (result.retryAfter) response.headers.set("Retry-After", String(result.retryAfter));
      return response;
    }
  }

  let text;
  try {
    const rawBody = await readBodyWithLimit(request, cfg.maxRequestBytes);
    const body = JSON.parse(rawBody);
    text = typeof body?.text === "string" ? body.text.trim() : "";
  } catch (e) {
    const code = e instanceof Error && e.message === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON";
    return err(code);
  }
  if (!text) return err("EMPTY_TEXT");
  if (text.length > cfg.maxSourceLength) return err("TEXT_TOO_LONG");

  const cacheKey = await getCacheKey(text);
  const cacheable = text.length <= cfg.cacheMaxTextLength;
  const cached = cacheable ? getCached(cacheKey, cfg.cacheTtlMs) : null;
  if (cached) return json(cached);

  try {
    const result = await deduplicator.deduplicate(cacheKey, async () => {
      return getCircuitBreaker().execute(async () => {
        let res;
        try {
          res = await callNvidia(key, cfg.model, text, cfg.timeoutMs);
        } catch (e) {
          if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
            throw new Error("TIMEOUT");
          }
          throw e;
        }
        if (!res.ok) {
          log("warn", "nvidia_upstream_error", { requestId, status: res.status });
          if ([401, 403].includes(res.status)) throw new Error("KEY_INVALID");
          if (res.status === 429) throw new Error("RATE_LIMITED");
          throw new Error("UPSTREAM_ERR");
        }
        const raw = await parseNvidiaStream(res);
        if (!raw.trim()) throw new Error("PARSE_ERROR");
        return parseTranslations(raw);
      }, (error) => !(error instanceof Error && ["KEY_INVALID", "RATE_LIMITED"].includes(error.message)));
    });
    if (cacheable) setCached(cacheKey, result, cfg.cacheMax);
    return json(result);
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (["CIRCUIT_OPEN", "PARSE_ERROR", "TIMEOUT", "KEY_INVALID", "RATE_LIMITED", "UPSTREAM_ERR"].includes(code)) {
      return err(code);
    }
    throw e;
  } finally {
    log("info", "translate_request", { requestId, durationMs: Date.now() - started });
  }
}

async function onRequest(context) {
  const { request } = context;
  try {
    return await handleRequest(context);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    log("error", "translate_unhandled_error", {
      requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
      message: error.message,
      stack: error.stack,
    });
    return err("UPSTREAM_ERR");
  }
}

export { onRequest };