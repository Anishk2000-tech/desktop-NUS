// The LM Studio client, driven against a real HTTP server that speaks LM
// Studio's API (scripts/mock-lmstudio.js): model discovery, model choice,
// streaming with thinking removed, JSON schemas and their fallbacks, and every
// error a student can actually hit.
const test = require('node:test');
const assert = require('node:assert/strict');
const local = require('./local-llm');
const { createMockLmStudio, DEFAULT_MODELS } = require('../scripts/mock-lmstudio');

const client = (cfg) => local.createLocalAI({ getConfig: () => cfg });

test('server addresses are forgiving: bare host, trailing slash, pasted endpoint', () => {
  assert.equal(local.normalizeBaseUrl(''), 'http://127.0.0.1:1234/v1');
  assert.equal(local.normalizeBaseUrl('localhost:1234'), 'http://localhost:1234/v1');
  assert.equal(local.normalizeBaseUrl('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234/v1');
  assert.equal(local.normalizeBaseUrl('http://127.0.0.1:1234/v1/chat/completions'), 'http://127.0.0.1:1234/v1');
  assert.equal(local.normalizeBaseUrl('http://192.168.1.20:5000/v1/'), 'http://192.168.1.20:5000/v1');
  assert.equal(local.serverRoot('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234');
  const cfg = local.resolveConfig({ timeoutSec: 'x', maxImageSide: 99999, temperature: -1 });
  assert.equal(cfg.timeoutSec, 300);
  assert.equal(cfg.maxImageSide, 4096);
  assert.equal(cfg.temperature, 0);
});

test('all three model-list shapes LM Studio has shipped parse to one shape', () => {
  const v0 = local.parseModelList({ object: 'list', data: DEFAULT_MODELS });
  assert.equal(v0.length, 3);
  assert.deepEqual(v0[0], { id: 'google/gemma-4-12b', type: 'vlm', state: 'loaded', vision: null, loadedContext: 16384, maxContext: 131072 });
  const native = local.parseModelList({ models: [{ type: 'llm', key: 'google/gemma-4-12b', capabilities: { vision: true }, max_context_length: 131072, loaded_instances: [{ id: 'google/gemma-4-12b', config: { context_length: 8192 } }] }] });
  assert.deepEqual(native[0], { id: 'google/gemma-4-12b', type: 'llm', state: 'loaded', vision: true, loadedContext: 8192, maxContext: 131072 });
  const openai = local.parseModelList({ object: 'list', data: [{ id: 'gemma-3-12b-it', object: 'model' }] });
  assert.deepEqual(openai[0], { id: 'gemma-3-12b-it', type: null, state: null, vision: null, loadedContext: null, maxContext: null });
});

test('model choice: the loaded model, Gemma for the screen, never an embedding model', () => {
  const models = local.parseModelList({ data: DEFAULT_MODELS });
  const cfg = local.resolveConfig({});
  assert.equal(local.pickModel(models, cfg, 'chat').model.id, 'google/gemma-4-12b');
  const vision = local.pickModel(models, cfg, 'vision');
  assert.equal(vision.model.id, 'google/gemma-4-12b', 'Gemma sees, so one model does both');

  // gpt-oss for chat: the screen still goes to Gemma, the model that can see.
  const split = local.resolveConfig({ chatModel: 'openai/gpt-oss-20b' });
  assert.equal(local.pickModel(models, split, 'chat').model.id, 'openai/gpt-oss-20b');
  assert.equal(local.pickModel(models, split, 'vision').model.id, 'google/gemma-4-12b');

  // A saved model that was deleted from LM Studio falls back and says so.
  const gone = local.pickModel(models, local.resolveConfig({ chatModel: 'old/model' }), 'chat');
  assert.equal(gone.model.id, 'google/gemma-4-12b');
  assert.equal(gone.missing, 'old/model');

  // Only text models: nothing can read the screen.
  const textOnly = local.parseModelList({ data: [DEFAULT_MODELS[1], DEFAULT_MODELS[2]] });
  assert.equal(local.pickModel(textOnly, cfg, 'chat').model.id, 'openai/gpt-oss-20b');
  assert.equal(local.pickModel(textOnly, cfg, 'vision'), null);
  assert.equal(local.pickModel(local.parseModelList({ data: [DEFAULT_MODELS[2]] }), cfg, 'chat'), null, 'embeddings are not chat models');
});

test('thinking never reaches the screen, even when a tag is split across chunks', () => {
  const run = (chunks) => { const f = local.createThinkFilter(); return chunks.map((c) => f.push(c)).join('') + f.flush(); };
  assert.equal(run(['<|chan', 'nel>thought\nplan it', '<chan', 'nel|>', '\n\nHello', ' there']), 'Hello there');
  assert.equal(run(['<th', 'ink>hmm</th', 'ink>Answer']), 'Answer');
  assert.equal(run(['Use < and > freely, a<b']), 'Use < and > freely, a<b');
  assert.equal(run(['Done. <think>never closed']), 'Done. ');
  assert.equal(local.stripThinking('<|channel>thought\n<channel|>Final'), 'Final');
  assert.equal(local.stripThinking('reasoning in the prompt</think>Final'), 'Final');
});

test('turns are merged so chat templates that demand alternation accept them; the image rides last', () => {
  const msgs = local.buildMessages({ system: 'sys', messages: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'assistant', text: 'c' }, { role: 'user', text: 'd' }], imageDataUrl: 'data:image/png;base64,AAAA' });
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs[1], { role: 'user', content: 'a\n\nb' });
  assert.equal(msgs[3].content[0].type, 'image_url');
  assert.equal(msgs[3].content[1].text, 'd');
});

test('status reads the loaded model, its context, and that it can see', async () => {
  const mock = await createMockLmStudio();
  try {
    const st = await client({ baseUrl: mock.url }).status();
    assert.equal(st.ok, true);
    assert.equal(st.chat.id, 'google/gemma-4-12b');
    assert.equal(st.chat.contextLength, 16384);
    assert.equal(st.vision.same, true);
    assert.equal(st.models.length, 2, 'the embedding model is not offered');
    assert.deepEqual(st.warnings, []);
  } finally { await mock.close(); }
});

test('a small context is flagged with the fix', async () => {
  const models = [{ ...DEFAULT_MODELS[0], loaded_context_length: 4096 }];
  const mock = await createMockLmStudio({ models });
  try {
    const st = await client({ baseUrl: mock.url }).status();
    assert.match(st.warnings.join(' '), /Context Length 16384/);
  } finally { await mock.close(); }
});

test('an answer arrives without Gemma\'s thought block, streamed or not', async () => {
  const mock = await createMockLmStudio();
  try {
    const ai = client({ baseUrl: mock.url });
    const whole = await ai.chat({ messages: [{ role: 'user', content: 'hello' }] });
    assert.match(whole.text, /^Local answer from google\/gemma-4-12b: hello$/);
    const tokens = [];
    const streamed = await ai.chat({ messages: [{ role: 'user', content: 'hello' }], stream: true, onToken: (t) => tokens.push(t) });
    assert.equal(streamed.text, whole.text);
    assert.equal(tokens.join(''), whole.text, 'only visible text is streamed');
    assert.ok(tokens.length > 3, 'and it streams in pieces');
    assert.doesNotMatch(tokens.join(''), /channel|thought/);
  } finally { await mock.close(); }
});

test('gpt-oss reasoning (delta.reasoning) is never shown, and it gets extra token budget', async () => {
  const mock = await createMockLmStudio({ reply: () => ({ reasoning: 'Let me think about this carefully.', content: 'Short answer.' }) });
  try {
    const ai = client({ baseUrl: mock.url, chatModel: 'openai/gpt-oss-20b' });
    const tokens = [];
    const r = await ai.chat({ messages: [{ role: 'user', content: 'q' }], stream: true, onToken: (t) => tokens.push(t), maxTokens: 400 });
    assert.equal(r.text, 'Short answer.');
    assert.equal(tokens.join(''), 'Short answer.');
    assert.equal(mock.requests.at(-1).body.max_tokens, 400 + 2048);
    assert.equal(mock.requests.at(-1).body.model, 'openai/gpt-oss-20b');
  } finally { await mock.close(); }
});

test('a screenshot goes to the vision model even when chat uses gpt-oss', async () => {
  const mock = await createMockLmStudio();
  try {
    const ai = client({ baseUrl: mock.url, chatModel: 'openai/gpt-oss-20b' });
    const r = await ai.chat({ messages: [{ role: 'user', content: 'What colour is this?' }], imageDataUrl: 'data:image/png;base64,AAAA' });
    assert.equal(r.text, 'Red');
    const sent = mock.requests.at(-1).body;
    assert.equal(sent.model, 'google/gemma-4-12b');
    assert.equal(sent.messages.at(-1).content[0].image_url.url, 'data:image/png;base64,AAAA');
  } finally { await mock.close(); }
});

test('a JSON schema becomes response_format, and comes back parsed', async () => {
  const mock = await createMockLmStudio();
  try {
    const ai = client({ baseUrl: mock.url });
    const r = await ai.chat({ messages: [{ role: 'user', content: '1 | Button | "Save" | 0.1,0.1,0.1,0.1' }], schema: { type: 'object' }, schemaName: 'point' });
    assert.equal(mock.requests.at(-1).body.response_format.type, 'json_schema');
    assert.equal(r.json.target.id, 1);
  } finally { await mock.close(); }
});

test('a server that refuses response_format is retried without it', async () => {
  const mock = await createMockLmStudio({
    reply: (body) => (body.response_format ? { status: 400, message: "'response_format.type' must be 'json_schema' or 'text'" } : { content: '{"ok": true}' }),
  });
  try {
    const r = await client({ baseUrl: mock.url }).chat({ messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' } });
    assert.deepEqual(r.json, { ok: true });
    assert.equal(mock.requests.filter((q) => q.method === 'POST').length, 2);
  } finally { await mock.close(); }
});

test('unusable constrained JSON gets one plain retry', async () => {
  let n = 0;
  const mock = await createMockLmStudio({ reply: () => ({ content: n++ === 0 ? 'not json at all' : 'Sure: {"answer": "fine", "walk": false}' }) });
  try {
    const r = await client({ baseUrl: mock.url }).chat({ messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' } });
    assert.deepEqual(r.json, { answer: 'fine', walk: false });
    assert.equal(mock.requests.filter((q) => q.method === 'POST').at(-1).body.response_format, undefined);
  } finally { await mock.close(); }
});

test('LM Studio closed: a sentence that says how to start it', async () => {
  const mock = await createMockLmStudio();
  const url = mock.url;
  await mock.close();
  const ai = client({ baseUrl: url });
  await assert.rejects(ai.chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'local_unreachable' && /Developer tab/.test(e.message));
  const st = await ai.status();
  assert.equal(st.ok, false);
  assert.equal(st.reachable, false);
});

test('running with nothing loaded is told apart from not running', async () => {
  const mock = await createMockLmStudio({ models: [DEFAULT_MODELS[2]] });
  try {
    const ai = client({ baseUrl: mock.url });
    const st = await ai.status();
    assert.equal(st.reachable, true);
    assert.equal(st.error, 'local_no_model');
    await assert.rejects(ai.chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'local_no_model');
  } finally { await mock.close(); }
});

test('server errors map to the fix: context, vision, memory', async () => {
  const cases = [
    ['The number of tokens to keep from the initial prompt is greater than the context length.', 'local_context'],
    ['Model does not support images. Please use a model that does.', 'local_no_vision'],
    ['Failed to load model: insufficient system resources', 'local_load_failed'],
  ];
  for (const [message, code] of cases) {
    const mock = await createMockLmStudio({ reply: () => ({ status: 400, message }) });
    try {
      await assert.rejects(client({ baseUrl: mock.url }).chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === code);
    } finally { await mock.close(); }
  }
});

test('an error inside the stream is not mistaken for an answer', async () => {
  const mock = await createMockLmStudio({ reply: () => ({ content: 'Partial', streamError: 'Context length exceeded' }) });
  try {
    await assert.rejects(client({ baseUrl: mock.url }).chat({ messages: [{ role: 'user', content: 'x' }], stream: true }), (e) => e.code === 'local_context');
  } finally { await mock.close(); }
});

test('cancel stops a stream; silence past the wait limit is a timeout', async () => {
  const slow = await createMockLmStudio({ chunkDelayMs: 40 });
  try {
    const ctrl = new AbortController();
    const p = client({ baseUrl: slow.url }).chat({ messages: [{ role: 'user', content: 'a long question' }], stream: true, signal: ctrl.signal, onToken: () => ctrl.abort() });
    await assert.rejects(p, (e) => e.code === 'local_cancelled');
  } finally { await slow.close(); }
  const hung = await createMockLmStudio({ reply: () => ({ hang: true }) });
  try {
    await assert.rejects(client({ baseUrl: hung.url }).chat({ messages: [{ role: 'user', content: 'x' }], timeoutMs: 300 }), (e) => e.code === 'local_timeout');
  } finally { await hung.close(); }
});

test('a reply that thought until the budget ran out says so instead of going blank', async () => {
  const mock = await createMockLmStudio({ reply: () => ({ reasoning: 'thinking...', content: '', finish: 'length' }) });
  try {
    await assert.rejects(client({ baseUrl: mock.url, chatModel: 'openai/gpt-oss-20b' }).chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'local_empty');
  } finally { await mock.close(); }
});

test('an LM Studio API token is sent when set, and a refusal says to add one', async () => {
  const mock = await createMockLmStudio({ requireToken: 'secret-token' });
  try {
    const refused = await client({ baseUrl: mock.url }).status();
    assert.equal(refused.ok, false);
    assert.match(refused.message, /API token/);
    const ok = await client({ baseUrl: mock.url, apiKey: 'secret-token' }).chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.match(ok.text, /hi/);
  } finally { await mock.close(); }
});

test('an older LM Studio without the native list still works through /v1/models', async () => {
  const mock = await createMockLmStudio({ noNative: true, models: [DEFAULT_MODELS[0]] });
  try {
    const st = await client({ baseUrl: mock.url }).status();
    assert.equal(st.ok, true);
    assert.equal(st.chat.id, 'google/gemma-4-12b');
    assert.equal(st.vision.id, 'google/gemma-4-12b', 'Gemma is recognised as a vision model by name');
  } finally { await mock.close(); }
});
