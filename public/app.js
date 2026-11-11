// src/frontend/i18n.ts
var TEXT = {
  cs: " 字符",
  copy: "复制",
  done: "已复制 ✓",
  fail: "翻译失败，请重试",
  emptyOut: "译文将在这里显示",
  ready: "就绪 · 等待输入",
  needText: "请先输入需要翻译的内容",
  busy: "正在翻译…",
  done0: "翻译完成 · 两种语言已更新",
  copied: "已复制 ",
  noResult: "未返回译文",
  missing: "模型返回内容缺少语言字段",
  copyFail: "复制失败：请检查浏览器剪贴板权限",
  pasteFail: "无法读取剪贴板内容，请授予浏览器粘贴权限",
  proxy404: "未找到翻译代理函数",
  noKeysCfg: "服务端未配置 NVIDIA_API_KEY",
  rateLimited: "请求过于频繁，请稍后重试",
  keyInvalid: "API Key 无效或已过期",
  timeout: "请求超时，请缩短原文或稍后重试",
  tooLong: "原文不能超过 20000 字符，请分段后重试",
  badJson: "请求格式错误",
  queued: "排队中…",
  tooLongLocal: "原文不能超过 20000 字符，请分段后重试"
};
var NAMES = { zh: "中文", ru: "俄语" };
function t(key) {
  return TEXT[key] ?? key;
}
function tName(lang) {
  return NAMES[lang];
}

// src/frontend/state.ts
function createInitialState(rateLimitMs) {
  return {
    seq: 0,
    ctrl: null,
    timer: null,
    nextAt: 0,
    rateLimitMs
  };
}
function abortCurrent(state) {
  state.ctrl?.abort();
  state.ctrl = new AbortController();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.seq++;
}
function setRateLimit(state, ms) {
  state.rateLimitMs = Math.max(400, ms);
}
function calculateWait(state) {
  return state.nextAt - Date.now();
}
function updateNextAt(state) {
  state.nextAt = Date.now() + state.rateLimitMs;
}
function getSignal(state) {
  return state.ctrl.signal;
}
function setTimer(state, timer) {
  state.timer = timer;
}
function clearTimer(state) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

// src/frontend/api.ts
var MAX_RETRIES = 1;
var RETRY_DELAYS = [2000];
var RETRYABLE_CODES = ["RATE_LIMITED", "TIMEOUT", "UPSTREAM_ERR"];
// 客户端兜底超时。要小于服务端 TIMEOUT_MS（默认 60000），
// 否则用户会一直盯着"正在翻译…"等服务端慢慢超时。
var CLIENT_TIMEOUT_MS = 45000;
var MAX_SOURCE_LENGTH = 20000;
// AbortSignal.any() 需要 Chrome/Edge 116+、Safari 17.4+、Firefox 124+，
// AbortSignal.timeout() 需要 Chrome 103+、Safari 16+、Firefox 100+。
// 老浏览器（尤其 iOS 17.3 及更早）上直接调用会抛 TypeError，导致翻译彻底不可用，
// 所以做特性检测：不支持就退回原来的行为（只受服务端超时约束）。
function combineSignal(signal) {
  if (typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.any([signal, AbortSignal.timeout(CLIENT_TIMEOUT_MS)]);
  }
  return signal;
}
async function requestTranslate(text, signal) {
  const res = await fetch("/api/translate", {
    method: "POST",
    signal: combineSignal(signal),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (res.headers.get("x-translator-proxy") !== "1") {
    const err = new Error("PROXY_404");
    err.code = "PROXY_404";
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message ?? `HTTP ${res.status}`);
    err.code = data.error?.code ?? "";
    err.status = res.status;
    err.retryAfter = res.headers.get("Retry-After");
    throw err;
  }
  if (!["zh", "ru"].every((k) => typeof data[k] === "string" && data[k].trim())) {
    const err = new Error("PARSE_ERROR");
    err.code = "PARSE_ERROR";
    throw err;
  }
  return { zh: data.zh, ru: data.ru };
}
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function translateWithRetry(text, signal, attempt = 0) {
  try {
    return await requestTranslate(text, signal);
  } catch (e) {
    const err = e;
    const retryable = RETRYABLE_CODES.includes(err.code ?? "");
    if (retryable && attempt < MAX_RETRIES && !signal.aborted) {
      const retryAfter = Number(err.retryAfter);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30000) : RETRY_DELAYS[attempt] ?? 3000;
      await wait(delay, signal);
      return translateWithRetry(text, signal, attempt + 1);
    }
    throw err;
  }
}
async function checkHealth() {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    if (r.headers.get("x-translator-proxy") !== "1") return null;
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    const minIntervalMs = Number(b.minIntervalMs);
    return Number.isFinite(minIntervalMs) ? { minIntervalMs } : {};
  } catch {
    return null;
  }
}

// src/frontend/ui.ts
var $ = (id) => document.getElementById(id);
function status(msg, type = "ready") {
  $("statusMsg").textContent = msg;
  $("dot").className = "sdot" + (type === "busy" ? " busy" : type === "err" ? " err" : "");
}
function showTranslations(data) {
  for (const k of ["zh", "ru"]) {
    const el = $("out-" + k);
    el.textContent = data[k].trim() || t("noResult");
    el.classList.remove("empty");
  }
}
function initTheme() {
  try {
    const theme = localStorage.getItem("theme");
    if (theme) document.documentElement.dataset["theme"] = theme;
    else if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.dataset["theme"] = "dark";
  } catch {}
  $("themeBtn").addEventListener("click", () => {
    const next = document.documentElement.dataset["theme"] === "dark" ? "light" : "dark";
    document.documentElement.dataset["theme"] = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
  });
}
function initCopyButtons() {
  document.querySelectorAll(".result").forEach((card) => {
    const btn = card.querySelector(".copy");
    let timeout = null;
    const copy = async () => {
      const k = card.dataset["k"];
      const el = $("out-" + k);
      if (el.classList.contains("empty")) return;
      try {
        await navigator.clipboard.writeText(el.textContent ?? "");
        btn.textContent = t("done");
        btn.classList.add("done");
        status(t("copied") + tName(k));
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
          btn.textContent = t("copy");
          btn.classList.remove("done");
        }, 1400);
      } catch {
        status(t("copyFail"), "err");
      }
    };
    card.addEventListener("click", copy);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      copy();
    });
  });
}
function bindInputEvents(source, onInput) {
  source.addEventListener("input", onInput);
}
function bindActionButtons(go, clearBtn, pasteBtn, onGo, onClear, onPaste) {
  go.addEventListener("click", onGo);
  clearBtn.addEventListener("click", onClear);
  pasteBtn.addEventListener("click", onPaste);
}
function updateCharCount(source) {
  $("count").textContent = source.value.length + t("cs");
}
function clearOutputs() {
  for (const k of ["zh", "ru"]) {
    const el = $("out-" + k);
    el.textContent = t("emptyOut");
    el.classList.add("empty");
  }
}

// src/frontend/app.ts
var source = document.getElementById("source");
var go = document.getElementById("go");
var clearBtn = document.getElementById("clear");
var pasteBtn = document.getElementById("paste");
var state = createInitialState(4800);
function onInput() {
  updateCharCount(source);
  abortCurrent(state);
  if (!source.value.trim()) {
    go.disabled = false;
    status(t("ready"));
    return;
  }
  setTimer(state, setTimeout(doTranslate, 750));
}
async function doTranslate() {
  const text = source.value.trim();
  if (!text) return status(t("needText"), "err");
  if (text.length > MAX_SOURCE_LENGTH) return status(t("tooLongLocal"), "err");
  abortCurrent(state);
  go.disabled = true;
  status(t("busy"), "busy");
  const n = state.seq;
  try {
    const waitMs = calculateWait(state);
    if (waitMs > 0) {
      status(t("queued"), "busy");
      await new Promise((r) => setTimeout(r, waitMs));
      if (n !== state.seq) return;
    }
    updateNextAt(state);
    const result = await translateWithRetry(text, getSignal(state));
    if (n !== state.seq) return;
    showTranslations(result);
    status(t("done0"));
  } catch (e) {
    if (e.name === "AbortError") return;
    if (n !== state.seq) return;
    const err = e;
    const code = err.code;
    const msg = code === "RATE_LIMITED" ? t("rateLimited") :
                code === "KEY_INVALID" ? t("keyInvalid") :
                code === "TIMEOUT" ? t("timeout") :
                code === "PAYLOAD_TOO_LARGE" || code === "TEXT_TOO_LONG" ? t("tooLong") :
                code === "EMPTY_TEXT" ? t("needText") :
                code === "INVALID_JSON" ? t("badJson") :
                code === "PARSE_ERROR" ? t("missing") :
                code === "NO_KEY" ? t("noKeysCfg") :
                code === "PROXY_404" ? t("proxy404") :
                code === "CIRCUIT_OPEN" ? t("fail") :
                t("fail");
    status(msg, "err");
  } finally {
    if (n === state.seq) go.disabled = false;
  }
}
function onClear() {
  clearTimer(state);
  abortCurrent(state);
  source.value = "";
  updateCharCount(source);
  clearOutputs();
  go.disabled = false;
  status(t("ready"));
}
async function onPaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text !== void 0) {
      source.value = text;
      source.dispatchEvent(new Event("input", { bubbles: true }));
      status(t("ready"));
    }
  } catch {
    status(t("pasteFail"), "err");
  }
}
initTheme();
initCopyButtons();
bindInputEvents(source, onInput);
bindActionButtons(go, clearBtn, pasteBtn, doTranslate, onClear, onPaste);
async function initHealthCheck() {
  const health = await checkHealth();
  if (health?.minIntervalMs) setRateLimit(state, health.minIntervalMs);
}
initHealthCheck();