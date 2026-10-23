// LM Studio client: the one AI Nūs Local Edition talks to.
//
// Everything that used to go to Claude (syllabus reading, the Ask bar, chat,
// voice) and to Gemini (the Companion's answers and screen guidance) goes to
// the LM Studio server on this machine instead, through its OpenAI-compatible
// endpoint (http://127.0.0.1:1234/v1 by default). No key, no account, nothing
// leaves the PC.
//
// Pure Node: no Electron import, so the test suite can drive it against a fake
// server. Callers hand in getConfig() (the saved settings) and, in tests, a
// fetch implementation.
'use strict';

const DEFAULT_BASE_URL = 'http://127.0.0.1:1234/v1';

const DEFAULTS = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  // '' = whatever LM Studio has loaded right now.
  chatModel: '',
  // '' = the chat model when it can see (Gemma does), else a loaded vision model.
  visionModel: '',
  // Only needed when LM Studio's server is set to require an API token.
  apiKey: '',
  // A 12B model split between a 4 GB GPU and system RAM can take a minute to
  // read a long prompt plus a screenshot. This is the longest silence allowed,
  // not a cap on the whole answer.
  timeoutSec: 300,
  temperature: 0.3,
  // Screenshots are shrunk to this many pixels on the long side before they
  // reach the model. Vision models resize to their own grid anyway; a 4K PNG
  // only costs encode time and memory.
  maxImageSide: 1280,
  // 0 = read the loaded context length from LM Studio.
  contextLength: 0,
});

const LIST_TIMEOUT_MS = 5000;
const LIST_CACHE_MS = 15000;

// Error codes callers can switch on. Every one has a sentence in errorMessage().
const CODES = Object.freeze([
  'local_unreachable', 'local_no_model', 'local_no_vision', 'local_context',
  'local_load_failed', 'local_timeout', 'local_empty', 'local_failed', 'local_cancelled',
]);

class LocalAIError extends Error {
  constructor(code, detail, extra = {}) {
    super(errorMessage(code, detail, extra.baseUrl));
    this.name = 'LocalAIError';
    this.code = code;
    this.detail = detail ? String(detail).slice(0, 500) : '';
    this.status = extra.status || null;
  }
}

function errorMessage(code, detail, baseUrl) {
  const where = baseUrl || DEFAULT_BASE_URL;
  switch (code) {
    case 'local_unreachable': return `LM Studio is not answering at ${where}. Open LM Studio, go to the Developer tab, load a model and switch the server to Running.`;
    case 'local_no_model': return 'LM Studio is running but has no chat model loaded. Load one (for example Gemma 4 12B) in LM Studio, then try again.';
    case 'local_no_vision': return 'This needs a model that can see the screen. Load a vision model such as Gemma 4 in LM Studio, or pick one under Settings, Local AI.';
    case 'local_context': return 'That was too long for the context length the model was loaded with. In LM Studio, reload the model with a larger Context Length (16384 works well), then try again.';
    case 'local_load_failed': return 'LM Studio could not load the model, usually because there is not enough memory. Close other apps, lower GPU offload, or use a smaller model.';
    case 'local_timeout': return 'The local model took too long to answer. A smaller or fully GPU-loaded model is faster; the wait limit is in Settings, Local AI.';
    case 'local_empty': return 'The model used its whole answer budget thinking and said nothing. Ask again, or use a non-reasoning model such as Gemma.';
    case 'local_cancelled': return 'Stopped.';
    default: return 'LM Studio returned an error' + (detail ? ': ' + String(detail).slice(0, 200) : '.');
  }
}

// ---- config -----------------------------------------------------------------

function normalizeBaseUrl(value) {
  let url = String(value || '').trim();
  if (!url) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  url = url.replace(/\/+$/, '');
  // People paste the bare server address, or the chat endpoint itself.
  url = url.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '');
  try {
    const parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname === '/') url = parsed.origin + '/v1';
  } catch { return DEFAULT_BASE_URL; }
  return url;
}

// The server root, where LM Studio's native /api/... endpoints live.
function serverRoot(baseUrl) {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, '');
}

function resolveConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  cfg.baseUrl = normalizeBaseUrl(cfg.baseUrl);
  cfg.chatModel = String(cfg.chatModel || '').trim();
  cfg.visionModel = String(cfg.visionModel || '').trim();
  cfg.apiKey = String(cfg.apiKey || '').trim();
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  cfg.timeoutSec = num(cfg.timeoutSec, 15, 3600, DEFAULTS.timeoutSec);
  cfg.temperature = num(cfg.temperature, 0, 2, DEFAULTS.temperature);
  cfg.maxImageSide = num(cfg.maxImageSide, 448, 4096, DEFAULTS.maxImageSide);
  cfg.contextLength = num(cfg.contextLength, 0, 1048576, 0);
  return cfg;
}

// ---- model discovery --------------------------------------------------------

const VISION_HINT = /gemma-?[34](?!.*\b(?:270m|1b)\b)|(^|[-_/.:])vl([-_/.:]|$)|vision|llava|pixtral|minicpm-v|moondream|smolvlm|internvl|llama-?4|mistral-small-3\.[12]|granite-vision|kimi-vl/i;
const REASONING_HINT = /gpt-oss|qwen3(?!.*instruct)|deepseek-r1|qwq|magistral|phi-4-(mini-)?reasoning|reasoning|thinking/i;

function isEmbedding(model) {
  return model.type === 'embeddings' || model.type === 'embedding' || /embed/i.test(model.id);
}

function canSee(model) {
  if (!model) return false;
  if (typeof model.vision === 'boolean') return model.vision;
  if (model.type === 'vlm') return true;
  if (model.type === 'llm') return false; // LM Studio says it has no vision projector
  return VISION_HINT.test(model.id);
}

function isReasoningModel(id) { return REASONING_HINT.test(String(id || '')); }

// Accepts LM Studio's /api/v0/models, its native /api/v1/models, or the
// OpenAI-compatible /v1/models, and returns one shape.
function parseModelList(json) {
  const out = [];
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  if (json && Array.isArray(json.models)) {
    for (const m of json.models) {
      const id = m.key || m.id || m.model_key;
      if (!id) continue;
      const instances = Array.isArray(m.loaded_instances) ? m.loaded_instances : [];
      const loadedCtx = instances.map((i) => num(i && i.config && i.config.context_length)).find(Boolean) || null;
      out.push({
        id: String(id),
        type: m.type || null,
        state: instances.length ? 'loaded' : 'not-loaded',
        vision: m.capabilities && typeof m.capabilities.vision === 'boolean' ? m.capabilities.vision : null,
        loadedContext: loadedCtx,
        maxContext: num(m.max_context_length),
      });
    }
    return out;
  }
  const items = json && Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
  for (const m of items) {
    const id = typeof m === 'string' ? m : m && m.id;
    if (!id) continue;
    out.push({
      id: String(id),
      type: (m && m.type) || null,
      state: (m && m.state) || null,
      vision: null,
      loadedContext: num(m && m.loaded_context_length),
      maxContext: num(m && m.max_context_length),
    });
  }
  return out;
}

// role 'chat' or 'vision'. Returns { model, auto, missing } or null.
function pickModel(models, cfg, role) {
  const usable = (models || []).filter((m) => !isEmbedding(m));
  if (!usable.length) return null;
  const find = (id) => usable.find((m) => m.id === id) || usable.find((m) => m.id.toLowerCase() === id.toLowerCase());
  const loaded = usable.filter((m) => m.state === 'loaded');
  const known = usable.some((m) => m.state);
  // Without state info (plain /v1/models) the list is usually just the loaded models.
  const live = known ? loaded : usable;

  const autoChat = () => {
    if (live.length) return live[0];
    // Nothing loaded but LM Studio can load on demand (JIT). Prefer Gemma,
    // which is what this edition is tuned for, over whatever sorts first.
    return usable.find((m) => /gemma/i.test(m.id)) || usable[0];
  };

  let missing = null;
  let chat = null;
  if (cfg.chatModel) { chat = find(cfg.chatModel); if (!chat) missing = cfg.chatModel; }
  const chatAuto = !chat;
  if (!chat) chat = autoChat();
  if (role !== 'vision') return { model: chat, auto: chatAuto, missing };

  if (cfg.visionModel) {
    const v = find(cfg.visionModel);
    if (v) return { model: v, auto: false, missing: null };
    missing = cfg.visionModel;
  }
  // The chat model itself when it can see: one model in memory, no swapping.
  if (canSee(chat)) return { model: chat, auto: true, missing };
  const seer = live.find(canSee) || usable.find(canSee);
  return seer ? { model: seer, auto: true, missing } : null;
}

// ---- reasoning / thinking output --------------------------------------------

const THINK_TAGS = [['<think>', '</think>'], ['<|channel>', '<channel|>']];

// Removes <think>…</think> and Gemma 4's <|channel>thought…<channel|> blocks
// from a token stream. Holds back a few characters whenever the tail might be
// the start of a tag, so a tag split across two chunks is still caught.
function createThinkFilter() {
  let inside = null; // the closing tag we are waiting for
  let buf = '';
  let started = false; // leading whitespace after a removed block is dropped
  const emit = (text) => {
    if (!started) {
      text = text.replace(/^\s+/, '');
      if (text) started = true;
    }
    return text;
  };
  const partialTail = (s, tags) => {
    for (let n = Math.min(s.length, 12); n > 0; n--) {
      const tail = s.slice(-n);
      if (tags.some((t) => t.startsWith(tail))) return n;
    }
    return 0;
  };
  return {
    push(chunk) {
      buf += String(chunk || '');
      let out = '';
      for (;;) {
        if (inside) {
          const end = buf.indexOf(inside);
          if (end === -1) { buf = buf.slice(buf.length - partialTail(buf, [inside])); return emit(out); }
          buf = buf.slice(end + inside.length);
          inside = null;
          continue;
        }
        let first = -1; let pair = null;
        for (const p of THINK_TAGS) {
          const at = buf.indexOf(p[0]);
          if (at !== -1 && (first === -1 || at < first)) { first = at; pair = p; }
        }
        if (first === -1) {
          const hold = partialTail(buf, THINK_TAGS.map((p) => p[0]));
          out += buf.slice(0, buf.length - hold);
          buf = buf.slice(buf.length - hold);
          return emit(out);
        }
        out += buf.slice(0, first);
        buf = buf.slice(first + pair[0].length);
        inside = pair[1];
      }
    },
    flush() {
      const rest = inside ? '' : buf;
      buf = '';
      return emit(rest);
    },
  };
}

function stripThinking(text) {
  let s = String(text || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\|channel>[\s\S]*?<channel\|>/g, '');
  // An unclosed block at the end is reasoning that ran out of budget.
  s = s.replace(/<think>[\s\S]*$/i, '').replace(/<\|channel>[\s\S]*$/, '');
  // Some templates open the block inside the prompt, so only the close shows.
  if (/<\/think>/i.test(s)) s = s.split(/<\/think>/i).pop();
  if (s.includes('<channel|>')) s = s.split('<channel|>').pop();
  return s.trim();
}

// Tolerant of fences and chatter around one JSON object.
function extractJson(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1];
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// ---- errors from the server ---------------------------------------------------

function classifyServerError(status, message) {
  const m = String(message || '').toLowerCase();
  if (/context (length|window|overflow|size)|n_ctx|tokens to keep|exceeds? the (available )?context|too many tokens|prompt is too long|context_length_exceeded/.test(m)) return 'local_context';
  if (/does not support (images|vision)|vision (is )?not supported|no vision|image input|images? (are|is) not supported|multimodal/.test(m)) return 'local_no_vision';
  if (/failed to load|out of memory|insufficient (system )?(memory|resources)|not enough memory|vram/.test(m)) return 'local_load_failed';
  if (status === 404 || /model .*not (found|loaded)|no models? (are )?loaded|model_not_found|no model/.test(m)) return 'local_no_model';
  return 'local_failed';
}

async function readErrorBody(res) {
  let text = '';
  try { text = await res.text(); } catch {}
  try {
    const json = JSON.parse(text);
    const e = json && json.error;
    if (typeof e === 'string') return e;
    if (e && e.message) return String(e.message);
    if (json && json.message) return String(json.message);
  } catch {}
  return text.slice(0, 500) || `HTTP ${res.status}`;
}

function isAbort(error) {
  return Boolean(error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ABORT_ERR'));
}

function networkCode(error) {
  const cause = error && (error.cause || error);
  const code = cause && (cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code));
  return String(code || '');
}

// ---- messages -------------------------------------------------------------------

// Chat templates (Gemma's among them) reject two turns of the same role in a
// row, so neighbours are merged. The image rides on the last user turn.
function buildMessages({ system, messages, imageDataUrl }) {
  const turns = [];
  for (const m of messages || []) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const text = String((m && (m.content != null ? m.content : m.text)) || '');
    if (!text.trim()) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.content += '\n\n' + text;
    else turns.push({ role, content: text });
  }
  if (!turns.length || turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', content: 'Continue.' });
  const out = [];
  if (system && String(system).trim()) out.push({ role: 'system', content: String(system) });
  turns.forEach((t, i) => {
    if (i === turns.length - 1 && imageDataUrl) {
      out.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }, { type: 'text', text: t.content }] });
    } else {
      out.push(t);
    }
  });
  return out;
}

// ---- the client ---------------------------------------------------------------------

function createLocalAI({ getConfig = () => ({}), fetchImpl, log = () => {} } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let cache = null; // { key, at, models }

  const config = () => resolveConfig(getConfig());

  function headers(cfg, json) {
    const h = {};
    if (json) h['content-type'] = 'application/json';
    if (cfg.apiKey) h.authorization = 'Bearer ' + cfg.apiKey;
    return h;
  }

  async function getJson(cfg, url) {
    const res = await doFetch(url, { headers: headers(cfg, false), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) { const detail = await readErrorBody(res); const e = new Error(detail); e.status = res.status; throw e; }
    return res.json();
  }

  // Native endpoints first: they say which models are loaded, which can see,
  // and the context length each was loaded with.
  async function listModels({ force = false } = {}) {
    const cfg = config();
    const key = cfg.baseUrl + '|' + cfg.apiKey;
    if (!force && cache && cache.key === key && Date.now() - cache.at < LIST_CACHE_MS) return cache.models;
    const root = serverRoot(cfg.baseUrl);
    const attempts = [root + '/api/v0/models', root + '/api/v1/models', cfg.baseUrl + '/models'];
    let lastError = null;
    for (const url of attempts) {
      try {
        const models = parseModelList(await getJson(cfg, url));
        if (models.length || url === attempts[attempts.length - 1]) {
          cache = { key, at: Date.now(), models };
          return models;
        }
      } catch (error) {
        lastError = error;
        // Nothing is listening at all: no point trying the other paths.
        if (!error.status && !isAbort(error)) break;
      }
    }
    cache = null;
    if (lastError && lastError.status === 401) throw new LocalAIError('local_failed', 'LM Studio asked for an API token. Paste it under Settings, Local AI.', { baseUrl: cfg.baseUrl, status: 401 });
    throw new LocalAIError('local_unreachable', lastError ? (networkCode(lastError) || lastError.message) : '', { baseUrl: cfg.baseUrl });
  }

  function forget() { cache = null; }

  async function resolve(role) {
    const cfg = config();
    const models = await listModels();
    const pick = pickModel(models, cfg, role);
    if (!pick) throw new LocalAIError(role === 'vision' && models.some((m) => !isEmbedding(m)) ? 'local_no_vision' : 'local_no_model', '', { baseUrl: cfg.baseUrl });
    if (pick.missing) log(`saved model "${pick.missing}" is not in LM Studio; using ${pick.model.id}`);
    return pick;
  }

  // What the Settings card shows. Never throws.
  async function status({ force = true } = {}) {
    const cfg = config();
    const base = { provider: 'lmstudio', baseUrl: cfg.baseUrl, chatModel: cfg.chatModel, visionModel: cfg.visionModel };
    let models;
    try { models = await listModels({ force }); }
    catch (error) {
      return { ...base, ok: false, reachable: false, models: [], error: error.code || 'local_unreachable', message: error.message };
    }
    const usable = models.filter((m) => !isEmbedding(m)).map((m) => ({ ...m, vision: canSee(m) }));
    const chat = pickModel(models, cfg, 'chat');
    const vision = pickModel(models, cfg, 'vision');
    const warnings = [];
    if (chat && chat.missing) warnings.push(`The saved chat model "${chat.missing}" is not in LM Studio, so ${chat.model.id} is used.`);
    if (vision && vision.missing && vision.missing !== (chat && chat.missing)) warnings.push(`The saved vision model "${vision.missing}" is not in LM Studio, so ${vision.model.id} is used.`);
    if (chat && !vision) warnings.push('No vision model is available, so screen guidance and screenshot questions will not work. Gemma 4 can see; load it in LM Studio.');
    const ctx = cfg.contextLength || (chat && chat.model.loadedContext) || null;
    if (ctx && ctx < 8192) warnings.push(`The model is loaded with a ${ctx}-token context. Reload it in LM Studio with Context Length 16384 so long syllabi fit.`);
    if (chat && chat.model.state === 'not-loaded') warnings.push(`${chat.model.id} is not loaded yet. LM Studio will load it on the first question (that one is slow), or load it yourself now.`);
    if (!chat) {
      return { ...base, ok: false, reachable: true, models: usable, error: 'local_no_model', message: errorMessage('local_no_model'), warnings };
    }
    return {
      ...base,
      ok: true,
      reachable: true,
      models: usable,
      chat: { id: chat.model.id, auto: chat.auto, state: chat.model.state, vision: canSee(chat.model), contextLength: ctx },
      vision: vision ? { id: vision.model.id, auto: vision.auto, state: vision.model.state, same: vision.model.id === chat.model.id } : null,
      warnings,
    };
  }

  function contextFor(model) {
    const cfg = config();
    return cfg.contextLength || (model && model.loadedContext) || null;
  }

  // One request. Returns { text, model, finishReason, json? }.
  //   role          'chat' | 'vision' (an image always means vision)
  //   system        system prompt
  //   messages      [{ role: 'user'|'assistant', content }]
  //   imageDataUrl  data:image/...;base64,... attached to the last user turn
  //   schema        JSON schema: asks LM Studio for constrained JSON output
  //   stream/onToken  hand tokens to onToken as they arrive (visible text
  //                 only, thinking removed); the wire is streamed either way
  //   signal        AbortSignal from the caller (cancel)
  async function chat(opts = {}) {
    const cfg = config();
    const role = opts.imageDataUrl ? 'vision' : (opts.role || 'chat');
    const pick = await resolve(role);
    const model = pick.model;
    const reasoning = isReasoningModel(model.id);
    const maxTokens = Math.max(64, Number(opts.maxTokens) || 1024) + (reasoning ? 2048 : 0);
    const payload = {
      model: model.id,
      messages: buildMessages(opts),
      temperature: opts.temperature != null ? opts.temperature : cfg.temperature,
      max_tokens: maxTokens,
      // Always streamed on the wire, even when the caller wants one string:
      // every token resets the silence timer, so a slow model writing a long
      // syllabus extraction is never mistaken for a hung one.
      stream: true,
    };
    if (opts.schema) {
      payload.response_format = { type: 'json_schema', json_schema: { name: opts.schemaName || 'reply', strict: true, schema: opts.schema } };
    }
    const result = await send(cfg, payload, opts);
    result.model = model.id;
    if (opts.schema) {
      result.json = extractJson(result.text);
      // Grammar-constrained output can still come back unusable from a model
      // whose template fights it. One plain retry, the prompt carries the shape.
      if (!result.json && !opts.stream) {
        log('structured output unusable, retrying without response_format');
        const retry = { ...payload };
        delete retry.response_format;
        const again = await send(cfg, retry, opts);
        again.model = model.id;
        again.json = extractJson(again.text);
        return again;
      }
    }
    return result;
  }

  async function send(cfg, payload, opts) {
    const dropped = new Set();
    for (;;) {
      const ctrl = new AbortController();
      const idleMs = Number(opts.timeoutMs) || cfg.timeoutSec * 1000;
      // Before the first token LM Studio is still reading the prompt, which on
      // a mostly-CPU 12B model can take minutes for a long one: twice the
      // allowance for that, then the plain limit between tokens.
      const firstMs = Number(opts.timeoutMs) || idleMs * 2;
      let timedOut = false;
      let timer = null;
      const arm = (ms = idleMs) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms); if (timer.unref) timer.unref(); };
      const onCallerAbort = () => ctrl.abort();
      if (opts.signal) {
        if (opts.signal.aborted) throw new LocalAIError('local_cancelled', '', { baseUrl: cfg.baseUrl });
        opts.signal.addEventListener('abort', onCallerAbort, { once: true });
      }
      arm(firstMs);
      try {
        let res;
        try {
          res = await doFetch(cfg.baseUrl + '/chat/completions', { method: 'POST', headers: headers(cfg, true), body: JSON.stringify(payload), signal: ctrl.signal });
        } catch (error) {
          if (timedOut) throw new LocalAIError('local_timeout', '', { baseUrl: cfg.baseUrl });
          if (isAbort(error)) throw new LocalAIError('local_cancelled', '', { baseUrl: cfg.baseUrl });
          forget();
          throw new LocalAIError('local_unreachable', networkCode(error) || error.message, { baseUrl: cfg.baseUrl });
        }
        if (!res.ok) {
          const detail = await readErrorBody(res);
          const lower = detail.toLowerCase();
          // Fields some servers or models refuse. Drop the one named, once, and retry.
          const field = ['response_format', 'temperature', 'max_tokens'].find((f) => (lower.includes(f) || (f === 'response_format' && /json_schema|grammar|structured/.test(lower))) && f in payload && !dropped.has(f));
          if (res.status === 400 && field) {
            log(`server refused ${field}; retrying without it`);
            dropped.add(field);
            delete payload[field];
            continue;
          }
          forget();
          throw new LocalAIError(classifyServerError(res.status, detail), detail, { baseUrl: cfg.baseUrl, status: res.status });
        }
        const isStream = /text\/event-stream/i.test(res.headers.get('content-type') || '');
        return isStream ? await readStream(res, opts, arm, cfg) : await readWhole(res, cfg);
      } catch (error) {
        if (error instanceof LocalAIError) throw error;
        if (timedOut) throw new LocalAIError('local_timeout', '', { baseUrl: cfg.baseUrl });
        if (isAbort(error)) throw new LocalAIError('local_cancelled', '', { baseUrl: cfg.baseUrl });
        throw new LocalAIError('local_failed', error && error.message, { baseUrl: cfg.baseUrl });
      } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
      }
    }
  }

  async function readWhole(res, cfg) {
    const data = await res.json();
    if (data && data.error) throw new LocalAIError(classifyServerError(200, data.error.message || data.error), data.error.message || data.error, { baseUrl: cfg.baseUrl });
    const choice = (data && data.choices && data.choices[0]) || {};
    const text = stripThinking(choice.message && choice.message.content);
    const finishReason = choice.finish_reason || null;
    if (!text && finishReason === 'length') throw new LocalAIError('local_empty', '', { baseUrl: cfg.baseUrl });
    return { text, finishReason };
  }

  async function readStream(res, opts, arm, cfg) {
    const filter = createThinkFilter();
    const decoder = new TextDecoder();
    const onToken = opts.stream && typeof opts.onToken === 'function' ? opts.onToken : () => {};
    let pending = '';
    let text = '';
    let finishReason = null;
    let done = false;
    const visible = (piece) => { if (piece) { text += piece; onToken(piece); } };
    const handle = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') { done = true; return; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { return; }
      if (chunk.error) {
        const msg = chunk.error.message || chunk.error;
        throw new LocalAIError(classifyServerError(200, msg), msg, { baseUrl: cfg.baseUrl });
      }
      for (const choice of chunk.choices || []) {
        const delta = choice.delta || {};
        // delta.reasoning (gpt-oss) and delta.reasoning_content are the
        // model thinking out loud: never shown, never spoken.
        if (typeof delta.content === 'string' && delta.content) visible(filter.push(delta.content));
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    };
    for await (const chunk of res.body) {
      arm();
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) { handle(line.trim()); if (done) break; }
      if (done) break;
    }
    if (!done && pending.trim()) handle(pending.trim());
    visible(filter.flush());
    text = stripThinking(text);
    if (!text && finishReason === 'length') throw new LocalAIError('local_empty', '', { baseUrl: cfg.baseUrl });
    return { text, finishReason };
  }

  return { config, listModels, forget, resolve, status, chat, contextFor };
}

module.exports = {
  createLocalAI,
  LocalAIError,
  errorMessage,
  resolveConfig,
  normalizeBaseUrl,
  serverRoot,
  parseModelList,
  pickModel,
  canSee,
  isReasoningModel,
  createThinkFilter,
  stripThinking,
  extractJson,
  buildMessages,
  classifyServerError,
  DEFAULTS,
  DEFAULT_BASE_URL,
  CODES,
};
