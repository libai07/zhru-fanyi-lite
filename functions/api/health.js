// src/backend/api/health.ts
//
// 刻意只返回前端真正需要的字段。模型名、熔断器状态、限流后端这些内部信息
// 不对外暴露；密钥是否配好通过 503 + NO_KEY 表达，不写进 body。
const CONFIG = {
  MIN_INTERVAL_MS: 4800,
};

function getKey(env) {
  const key = (env.NVIDIA_API_KEY ?? "").trim();
  if (!key) throw Object.assign(new Error("NO_KEY"), { code: "NO_KEY" });
  return key;
}

// 与 translate.js 中的 clampInt / MIN_INTERVAL_MS 默认值保持一致
function clampInt(val, def, min, max) {
  if (val === undefined || val === "") return def;
  const n = Number(val);
  return Number.isSafeInteger(n) ? Math.min(max, Math.max(min, n)) : def;
}

function log(level, event, fields = {}) {
  console[level](JSON.stringify({ service: "zhru-fanyi-lite", event, ...fields, ts: new Date().toISOString() }));
}

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-translator-proxy", "1");
  return Response.json(data, { ...init, headers });
}

async function onRequest({ request, env }) {
  const started = Date.now();
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  const minIntervalMs = clampInt(env.MIN_INTERVAL_MS, CONFIG.MIN_INTERVAL_MS, 0, 60000);
  try {
    getKey(env);
    log("info", "health_check", { requestId, durationMs: Date.now() - started });
    return json({ ok: true, minIntervalMs });
  } catch (e) {
    const error = e;
    log("error", "health_check_failed", {
      requestId,
      code: error.code ?? "HEALTH_ERROR",
      message: error.message,
      durationMs: Date.now() - started
    });
    return json({
      ok: false,
      error: { message: error.message, code: error.code ?? "HEALTH_ERROR" }
    }, { status: 503 });
  }
}

export { onRequest };
