// The desktop AI layer end to end against a fake LM Studio: settings saved
// through the real store, syllabus reading that fits whatever context the
// model was loaded with, Ask-bar commands, and the two Settings self-tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createMockLmStudio, DEFAULT_MODELS } = require('../scripts/mock-lmstudio');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-ai-test-'));
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } };
  return realLoad.call(this, request, ...rest);
};
const store = require('../companion/src/store');
const ai = require('./ai');
const assistant = require('./assistant');
test.after(() => { Module._load = realLoad; fs.rmSync(userData, { recursive: true, force: true }); });

function syllabus(weeks) {
  const lines = ['Course: Computer Science II', 'Code: COSC 1437', 'Term: Fall 2026', '', 'Grading', 'Homework 20%', 'Labs 30%', 'Exams 50%', '', 'Schedule'];
  for (let i = 1; i <= weeks; i++) {
    const day = String(((i - 1) % 28) + 1).padStart(2, '0');
    const month = String(8 + Math.floor((i - 1) / 28)).padStart(2, '0');
    lines.push(`Week ${i}: ${'Reading and discussion of the assigned chapter, with in-class practice problems. '.repeat(3)}`);
    lines.push(`2026-${month}-${day} Lab ${i}`);
  }
  return lines.join('\n');
}

async function withMock(opts, fn) {
  const mock = await createMockLmStudio(opts);
  ai.setConfig({ baseUrl: mock.url, chatModel: '', visionModel: '' });
  try { await fn(mock); } finally { await mock.close(); }
}

test('settings are saved in the one store, validated, and the token is never echoed back', async () => {
  await withMock({}, async (mock) => {
    ai.setConfig({ baseUrl: mock.url.replace('/v1', '/'), timeoutSec: 5, apiKey: 'tok' });
    const saved = store.getSettings().local;
    assert.equal(saved.baseUrl, mock.url);
    assert.equal(saved.timeoutSec, 15, 'clamped to the minimum');
    const st = await ai.status();
    assert.equal(st.config.apiKey, '');
    assert.equal(st.config.hasApiKey, true);
    ai.setConfig({ apiKey: '' });
    assert.equal(store.getSettings().local.apiKey, 'tok', 'an empty field keeps the saved token');
    ai.setConfig({ clearApiKey: true });
    assert.equal(store.getSettings().local.apiKey, '');
    ai.setConfig({ timeoutSec: 300 });
  });
});

test('a short syllabus is read in one pass with a schema', async () => {
  await withMock({}, async (mock) => {
    const result = await ai.extractSyllabus(syllabus(4));
    assert.equal(result.course.name, 'Computer Science II');
    assert.equal(result.course.code, 'COSC 1437');
    assert.equal(result.grade_weights.length, 3);
    assert.deepEqual(result.assignments.map((a) => a.title), ['Lab 1', 'Lab 2', 'Lab 3', 'Lab 4']);
    const posts = mock.requests.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.response_format.json_schema.name, 'syllabus');
    assert.match(posts[0].body.messages[0].content, /You extract structured data from a course syllabus/);
  });
});

test('a long syllabus at a 4K context is read in parts and merged without duplicates', async () => {
  const models = [{ ...DEFAULT_MODELS[0], loaded_context_length: 4096 }];
  await withMock({ models }, async (mock) => {
    const text = syllabus(60);
    const result = await ai.extractSyllabus(text);
    const posts = mock.requests.filter((r) => r.method === 'POST');
    assert.ok(posts.length > 1, `split into ${posts.length} parts`);
    for (const p of posts) assert.ok(p.body.messages[1].content.length < 6000, 'every part fits the context');
    assert.match(posts[1].body.messages[0].content, /This is part 2 of/);
    assert.equal(result.course.name, 'Computer Science II', 'course from the first part');
    assert.equal(result.grade_weights.length, 3, 'weights are not repeated');
    assert.equal(result.assignments.length, 60, 'every lab exactly once, overlap removed');
  });
});

test('a context smaller than reported halves the parts instead of failing', async () => {
  // Reported 16K, really ~2K: anything longer than 4000 characters overflows.
  await withMock({
    reply: (body) => {
      const user = body.messages.find((m) => m.role === 'user').content;
      if (user.length > 4000) return { status: 400, message: 'The number of tokens to keep from the initial prompt is greater than the context length' };
      return { content: JSON.stringify(require('../scripts/mock-lmstudio').cannedSyllabus(user)) };
    },
  }, async () => {
    const result = await ai.extractSyllabus(syllabus(40));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.assignments.length, 40);
  });
});

test('LM Studio closed: import says so with the fix, and the error is logged', async () => {
  const mock = await createMockLmStudio();
  const url = mock.url;
  await mock.close();
  ai.setConfig({ baseUrl: url });
  const result = await ai.extractSyllabus(syllabus(2));
  assert.equal(result.error, 'local_unreachable');
  assert.match(result.message, /Developer tab/);
  assert.equal(ai.isProviderError(result.error), true);
  assert.match(fs.readFileSync(path.join(userData, 'ai-errors.log'), 'utf8'), /local_unreachable/);
});

test('an Ask-bar request becomes a schema-constrained command with the local date', async () => {
  await withMock({}, async (mock) => {
    const result = await assistant.parseCommand('add task: finish lab report due 2026-11-02', 'Courses: none');
    assert.equal(result.command.intent, 'add_task');
    assert.equal(result.command.title, 'finish lab report');
    assert.equal(result.command.due_date, '2026-11-02');
    const body = mock.requests.filter((r) => r.method === 'POST').at(-1).body;
    assert.equal(body.response_format.json_schema.name, 'command');
    assert.match(body.messages.at(-1).content, new RegExp(`Today is ${assistant.localDate()} \\(`));
  });
});

test('the Settings self-tests prove chat and sight separately', async () => {
  await withMock({}, async () => {
    const chat = await ai.testConnection();
    assert.equal(chat.ok, true);
    assert.equal(chat.model, 'google/gemma-4-12b');
    const sight = await ai.testVision();
    assert.equal(sight.ok, true, JSON.stringify(sight));
  });
  // Only a text model loaded: vision fails with the fix, chat still works.
  await withMock({ models: [{ ...DEFAULT_MODELS[1], state: 'loaded' }] }, async () => {
    assert.equal((await ai.testConnection()).ok, true);
    const sight = await ai.testVision();
    assert.equal(sight.error, 'local_no_vision');
    assert.match(sight.message, /Gemma 4/);
  });
});

test('a voice answer streams and can be cancelled', async () => {
  await withMock({ chunkDelayMs: 30 }, async () => {
    const events = [];
    const pending = ai.completeStream('Student: what is next?\nNūs:', (ev) => { events.push(ev); if (events.length === 2) ai.cancelStream(); });
    const result = await pending;
    assert.equal(result.error, 'local_cancelled');
    assert.ok(events.every((e) => e.type === 'delta'));
  });
});

test('splitting keeps rows whole and merging prefers a dated copy', () => {
  const parts = ai._splitText('a\n'.repeat(5000), 3000, 100);
  assert.ok(parts.every((p) => p.length <= 3000));
  assert.ok(parts.every((p) => p.endsWith('\n') || p === parts.at(-1)), 'cuts land on line breaks');
  const merged = ai._mergeExtractions([
    { course: { name: '', code: 'X', credit_hours: null, term: null }, grade_weights: [{ category: 'Labs', weight_pct: 30 }], assignments: [{ title: 'Quiz 1', due_date: null, category: null }] },
    { course: { name: 'Physics', code: null, credit_hours: 4, term: null }, grade_weights: [{ category: 'labs', weight_pct: 30 }], assignments: [{ title: 'Quiz 1', due_date: '2026-09-01', category: 'Quizzes' }, { title: 'Quiz 1', due_date: '2026-09-01', category: null }] },
  ]);
  assert.deepEqual(merged.course, { name: 'Physics', code: 'X', credit_hours: 4, term: null });
  assert.equal(merged.grade_weights.length, 1);
  assert.deepEqual(merged.assignments, [{ title: 'Quiz 1', due_date: '2026-09-01', category: 'Quizzes' }]);
});
