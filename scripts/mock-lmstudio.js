// A stand-in for LM Studio's local server, for the test suite and for trying
// Nūs without a model loaded. It speaks the same three endpoints Nūs uses:
//   GET  /api/v0/models          LM Studio's native list (type, state, context)
//   GET  /v1/models              the OpenAI-compatible list
//   POST /v1/chat/completions    streaming and not, with response_format
//
// Replies are canned but shaped like the real thing, including Gemma 4's
// <|channel>thought…<channel|> block and gpt-oss's delta.reasoning, so the
// client's filtering is exercised for real.
//
//   node scripts/mock-lmstudio.js            listens on http://localhost:1234
//   node scripts/mock-lmstudio.js --port 4321
'use strict';

const http = require('http');

const DEFAULT_MODELS = [
  { id: 'google/gemma-4-12b', object: 'model', type: 'vlm', publisher: 'google', arch: 'gemma4', compatibility_type: 'gguf', quantization: 'Q4_K_M', state: 'loaded', max_context_length: 131072, loaded_context_length: 16384 },
  { id: 'openai/gpt-oss-20b', object: 'model', type: 'llm', publisher: 'openai', arch: 'gpt-oss', compatibility_type: 'gguf', quantization: 'MXFP4', state: 'not-loaded', max_context_length: 131072 },
  { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model', type: 'embeddings', publisher: 'nomic-ai', arch: 'nomic-bert', compatibility_type: 'gguf', quantization: 'Q4_K_M', state: 'not-loaded', max_context_length: 2048 },
];

function lastUserText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  }
  return '';
}

function hasImage(body) {
  return (body.messages || []).some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

function systemText(body) {
  return (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
}

// Reads "Course: ...", "Homework 20%" and "2026-09-14 Quiz 1" style lines.
function cannedSyllabus(text) {
  const course = (text.match(/^\s*course:\s*(.+)$/im) || [])[1] || null;
  const code = (text.match(/^\s*code:\s*(.+)$/im) || [])[1] || null;
  const term = (text.match(/^\s*term:\s*(.+)$/im) || [])[1] || null;
  const weights = [];
  for (const m of text.matchAll(/^\s*([A-Za-z][A-Za-z ]{1,40}?)\s+(\d{1,3})%\s*$/gm)) weights.push({ category: m[1].trim(), weight_pct: Number(m[2]) });
  const assignments = [];
  for (const m of text.matchAll(/^\s*(\d{4}-\d{2}-\d{2})\s+(.+?)\s*$/gm)) {
    const title = m[2].trim();
    const category = (weights.find((w) => title.toLowerCase().includes(w.category.toLowerCase().replace(/s$/, ''))) || {}).category || null;
    assignments.push({ title, due_date: m[1], category });
  }
  return { course: { name: course ? course.trim() : '', code: code ? code.trim() : null, credit_hours: null, term: term ? term.trim() : null }, grade_weights: weights, assignments };
}

function cannedCommand(text) {
  const request = text.split('===REQUEST===').pop().trim();
  const base = { intent: 'question', title: null, due_date: null, time: null, course: null, estimated_minutes: null, target_title: null, new_due_date: null, help_type: null, question: request, confidence: 0.9, summary_for_user: 'Answer the question.' };
  const add = request.match(/^(?:add|create)(?: a)? task:?\s+(.+?)(?:\s+due\s+(\d{4}-\d{2}-\d{2}))?$/i);
  if (add) return { ...base, intent: 'add_task', title: add[1], due_date: add[2] || null, question: null, summary_for_user: `Create the task "${add[1]}"${add[2] ? ' due ' + add[2] : ''}.` };
  return base;
}

function cannedPoint(text) {
  const first = text.match(/^(\d+) \| ([^|]+) \| "([^"]*)"/m);
  if (first) return { instruction: `Click ${first[3] || 'this control'}`, target: { kind: 'element', id: Number(first[1]) }, confidence: 0.85, done: false, note: '' };
  return { instruction: 'Open the app you need help with first.', target: null, confidence: 0.9, done: false, note: 'No controls are listed for this window.' };
}

function defaultReply(body, model) {
  const text = lastUserText(body);
  const schema = body.response_format && body.response_format.json_schema && body.response_format.json_schema.name;
  if (schema === 'syllabus') return { content: JSON.stringify(cannedSyllabus(text)) };
  if (schema === 'command') return { content: JSON.stringify(cannedCommand(text)) };
  if (schema === 'point') return { content: JSON.stringify(cannedPoint(text)) };
  if (schema === 'select') return { content: JSON.stringify({ answer: 'That control opens the next screen.', walk: false }) };
  if (/Reply with exactly the word OK/i.test(text)) return { content: 'OK' };
  if (hasImage(body)) return { content: /colour|color/i.test(text) ? 'Red' : 'I can see the screen: a window with a toolbar and some buttons.' };
  if (/STUDENT CONTEXT|Nūs:/.test(text) || /semester/i.test(systemText(body))) {
    return { content: `From your semester (answered locally by ${model}): start with the item due soonest, then block an hour for the next one.` };
  }
  return { content: `Local answer from ${model}: ${text.slice(0, 120)}` };
}

function createMockLmStudio(opts = {}) {
  const models = opts.models || DEFAULT_MODELS;
  const requests = [];
  const reply = opts.reply || defaultReply;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (opts.requireToken && req.headers.authorization !== 'Bearer ' + opts.requireToken) return json(401, { error: 'Unauthorized' });
      if (req.method === 'GET' && req.url === '/api/v0/models') {
        if (opts.noNative) return json(404, { error: 'Unexpected endpoint or method.' });
        return json(200, { object: 'list', data: models });
      }
      if (req.method === 'GET' && req.url === '/api/v1/models') return json(404, { error: 'Unexpected endpoint or method.' });
      if (req.method === 'GET' && req.url === '/v1/models') {
        return json(200, { object: 'list', data: models.filter((m) => m.state !== 'not-loaded' || opts.jit !== false).map((m) => ({ id: m.id, object: 'model', owned_by: m.publisher || 'organization_owner' })) });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const model = body && body.model;
        if (!models.some((m) => m.id === model)) return json(404, { error: { message: `Model "${model}" not found. Please load it first.` } });
        let r = await reply(body, model, requests);
        if (r && r.status) return json(r.status, r.json || { error: { message: r.message || 'error' } });
        if (r && r.hang) return; // never answers: exercises the client's timeout
        r = r || { content: '' };
        const isGemma = /gemma/i.test(model);
        const thought = opts.thinkTags !== false && isGemma ? '<|channel>thought\n' + (r.thought || '') + '<channel|>' : '';
        const content = thought + (r.content || '');
        const finish = r.finish || 'stop';
        if (!body.stream) {
          return json(200, { id: 'chatcmpl-mock', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content, ...(r.reasoning ? { reasoning: r.reasoning } : {}) }, finish_reason: finish }] });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (delta, finishReason = null) => res.write('data: ' + JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\n');
        if (r.reasoning) for (const piece of r.reasoning.match(/.{1,6}/gs) || []) send({ reasoning: piece });
        // Small, uneven pieces so tags and words split across chunks.
        const pieces = content.match(/.{1,5}/gs) || [];
        for (const piece of pieces) { send({ content: piece }); if (opts.chunkDelayMs) await new Promise((x) => setTimeout(x, opts.chunkDelayMs)); }
        if (r.streamError) { res.write('data: ' + JSON.stringify({ error: { message: r.streamError } }) + '\n\n'); return res.end(); }
        send({}, finish);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      json(404, { error: 'Unexpected endpoint or method.' });
    });
  });
  return new Promise((resolve) => {
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { createMockLmStudio, DEFAULT_MODELS, cannedSyllabus };

if (require.main === module) {
  const at = process.argv.indexOf('--port');
  const port = at > -1 ? Number(process.argv[at + 1]) : 1234;
  createMockLmStudio({ port, chunkDelayMs: 25 }).then((mock) => {
    console.log(`Mock LM Studio listening on ${mock.url} (Ctrl+C to stop)`);
  });
}
