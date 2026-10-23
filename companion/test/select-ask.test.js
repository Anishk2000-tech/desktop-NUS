// 2026-09-15, Pranav's first play session on the day-1 build:
//   1. guide steps keep going in apps that expose nothing to UI Automation
//      (CapCut) instead of refusing;
//   2. the one-line composer no longer overlaps the status capsule;
//   3. Ctrl+Shift+T is back: point at the control under the cursor and ask.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const { validatePoint, SYSTEM } = require('../src/guide/pointing');
const { reconcile } = require('../src/guide/verify');

test('a bbox a hair past the screen edge is trimmed, not rejected', () => {
  const r = validatePoint({ instruction: 'Click Start', target: { kind: 'bbox', x: 0.005, y: 0.983, w: 0.14, h: 0.03, label: 'Start' }, confidence: 0.9 }, []);
  assert.equal(r.ok, true, r.reason);
  assert.ok(Math.abs(r.reply.target.y + r.reply.target.h - 1) < 1e-9, 'bottom edge trimmed to the screen');
  const far = validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.9, y: 0.1, w: 0.3, h: 0.1 }, confidence: 0.9 }, []);
  assert.equal(far.reason, 'bbox out of range', 'a box well past the edge is still a miss');
});

test('the pointing contract tells the model to keep going in apps with no control list', () => {
  assert.match(SYSTEM, /list few or no controls\. Then use a bbox/);
  assert.match(SYSTEM, /one click at a time/);
});

test('Windows disagreeing with the model box points at the box, flagged as a guess', () => {
  const bboxPhys = { x: 100, y: 100, w: 100, h: 40 };
  const r = reconcile({ target: { kind: 'bbox', label: 'Text' }, bboxPhys, fromPoint: { name: 'Whole window', rect: { x: 0, y: 0, w: 1900, h: 1000 } }, found: null, verified: true });
  assert.ok(r, 'never null for a bbox any more');
  assert.equal(r.verified, false);
  assert.equal(r.source, 'model');
  assert.deepEqual(r.rect, bboxPhys);
});

test('the capsule folds while the one-line composer is open', () => {
  assert.match(css, /#toolbar\.quick-open #knot-bloom \{ opacity: 0 !important;/);
  assert.match(js, /\$\('#toolbar'\)\.classList\.add\('quick-open'\);/);
  assert.match(js, /\$\('#toolbar'\)\.classList\.remove\('quick-open'\);/);
});

test('Ctrl+Shift+T selects the control under the cursor and opens the composer about it', () => {
  assert.match(main, /globalShortcut\.register\('CommandOrControl\+Shift\+T', FOUNDER \? harnessStep : selectAtCursor\);/);
  assert.match(main, /async function selectAtCursor\(\)/);
  assert.match(main, /send\('guide:target', \{ bbox, task: 'ask', kicker: 'selected'/, 'the thread goes to the selection first');
  assert.match(main, /send\('quick:open', \{ context: /);
  assert.match(main, /if \(!win\.isAlwaysOnTop\(\)\) \{ console\.log\('\[select\] focus\(\) stripped topmost; restoring'\); await restoreTopmost\('select'\); \}/, 'focus() may strip topmost; put it back');
  assert.match(preload, /'quick:open'\]/, 'the renderer may receive quick:open');
  assert.match(js, /nus\.on\('quick:open', \(p\) => openQuickAsk\(/);
  assert.match(js, /nus\.guideAsk\(\{ text, source: 'typed', about: !!about \}\)/);
});

test('a question about the selection is answered at the thread tip and can become a walkthrough', () => {
  assert.match(main, /if \(p\.about && selection\) \{ answerSelection\(p\.text\); return; \}/);
  assert.match(main, /if \(p && p\.action === 'walk' && selection\) \{ walkFromSelection\(\); return; \}/);
  assert.match(main, /send\('guide:bubble', \{ text: answer[^\n]*anchor: 'tip', task: 'ask'[^\n]*\{ id: 'walk', label: 'Walk me through it', primary: walk \}, \{ id: 'dismiss', label: 'OK' \}/);
  assert.match(main, /getGuide\(\)\.start\(sel\.question, 'typed'\);/);
  assert.match(main, /selection = null;\n  if \(wasActive\)/, 'Esc and a Knot click clear the selection');
});

test('guide steps go to the LM Studio vision model with the screenshot inline and a strict JSON schema', () => {
  const desktop = fs.readFileSync(path.join(root, '..', 'src', 'main.js'), 'utf8');
  const llm = fs.readFileSync(path.join(root, 'src', 'llm.js'), 'utf8');
  const session = fs.readFileSync(path.join(root, 'src', 'guide', 'session.js'), 'utf8');
  // No second AI behind the Companion's back: the Claude CLI fallback is gone.
  assert.doesNotMatch(main, /desktopComplete/);
  assert.doesNotMatch(desktop, /desktopComplete/);
  assert.match(main, /function guideLlm\(\) \{\n  return createLLM\(store\.getSettings\(\)\);\n\}/);
  // The image rides on the request; a screenshot always means the vision model.
  assert.match(llm, /imageDataUrl: params\.imageDataUrl \|\| null/);
  assert.match(session, /schema: POINT_SCHEMA, schemaName: 'point'/);
  const { POINT_SCHEMA } = require('../src/guide/pointing');
  assert.deepEqual(POINT_SCHEMA.required, ['instruction', 'target', 'confidence', 'done', 'note']);
  assert.equal(POINT_SCHEMA.properties.target.anyOf.length, 3, 'element, bbox, or null');
});

test('a hedged pick is pointed at as a best guess instead of refused', () => {
  const session = fs.readFileSync(path.join(root, 'src', 'guide', 'session.js'), 'utf8');
  const pointing = require('../src/guide/pointing');
  assert.equal(pointing.CONF_SURE, 0.6);
  assert.match(session, /const sure = hit\.verified && reply\.confidence >= CONF_SURE;/);
  assert.match(session, /verified: sure, source: hit\.source/);
  // A reasoning model (gpt-oss) spends tokens thinking before the JSON; the
  // client adds that budget so a 400-token step never comes back empty.
  const local = fs.readFileSync(path.join(root, '..', 'src', 'local-llm.js'), 'utf8');
  assert.match(local, /\+ \(reasoning \? 2048 : 0\)/);
});

test('the guide shrinks screenshots to the Local AI size, and waits as long as LM Studio may', () => {
  // A local vision model resizes to its own grid; on a 4 GB GPU a smaller frame
  // is seconds instead of a minute. NUS_GUIDE_MAXSIDE still overrides.
  assert.match(main, /return Number\(process\.env\.NUS_GUIDE_MAXSIDE\) \|\| localAi\(\)\.getConfig\(\)\.maxImageSide;/);
  assert.match(main, /capture: \(\) => captureDisplay\(store\.getSettings\(\)\.knotDisplayId, \{ maxSide: guideMaxSide\(\) \}\)/);
  assert.match(main, /modelTimeoutMs: \(\) => localAi\(\)\.getConfig\(\)\.timeoutSec \* 2000 \+ 30000/);
});

test('password and card fields are refused locally, by the guide and by select-and-ask', () => {
  const { sensitiveTarget } = require('../src/guide/sensitive');
  assert.equal(sensitiveTarget({ name: 'Password', type: 'Edit' }), true);
  assert.equal(sensitiveTarget({ name: 'Card number', type: 'Edit' }), true);
  assert.equal(sensitiveTarget({ name: 'Search', type: 'Edit' }), false);
  assert.equal(sensitiveTarget({ name: 'Password', type: 'Button' }), false, 'a button labelled Password is not a field');
  const session = fs.readFileSync(path.join(root, 'src', 'guide', 'session.js'), 'utf8');
  assert.match(session, /require\('\.\/sensitive'\)/);
  assert.match(session, /if \(sensitiveTarget\(/, 'the guide checks the resolved control, not just the prompt');
  assert.match(main, /if \(sensitiveTarget\(\{ name, type \}\)\)/, 'select-and-ask uses the same guard');
});
