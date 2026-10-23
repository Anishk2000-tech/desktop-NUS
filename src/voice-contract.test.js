// Voice-with-the-Knot contract: regex-over-source assertions that pin the
// security and UI invariants of the voice feature, in the same style as
// ui-contract.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

const sttLocal = read('src', 'stt-local.js');
const aiJs = read('src', 'ai.js');
const mainJs = read('src', 'main.js');
const preloadJs = read('src', 'preload.js');
const companionIndex = read('companion', 'index.js');
const knot3d = read('companion', 'renderer', 'knot3d.js');
const appJs = read('renderer', 'app.js');
const stylesCss = read('renderer', 'styles.css');
const indexHtml = read('renderer', 'index.html');

test('local STT spawns whisper with bare-transcript flags and no hardcoded user path', () => {
  assert.match(sttLocal, /'-nt'/, 'whisper must run with -nt so stdout is the bare transcript');
  assert.match(sttLocal, /'-np'/);
  assert.ok(!/C:\\\\Users|C:\/Users/i.test(sttLocal), 'no hardcoded user paths in stt-local');
  assert.match(sttLocal, /windowsHide: true/);
});

test('voice answers stream from LM Studio and can be cancelled mid-answer', () => {
  // One AbortController per stream: talking over the Knot or closing voice
  // stops the local model instead of letting it finish into the void.
  assert.match(aiJs, /stream: true,\n      onToken: \(text\) => onEvent\(\{ type: 'delta', text \}\),\n      signal: ctrl\.signal,/);
  assert.match(aiJs, /function cancelStream\(\) \{\n  if \(!streamAbort\) return \{ ok: false \};\n  streamAbort\.abort\(\);/);
  assert.match(mainJs, /'voice:cancel': \(\) => ai\.cancelStream\(\)/);
  // Thinking never reaches the transcript or the speaker.
  assert.match(read('src', 'local-llm.js'), /delta\.reasoning \(gpt-oss\) and delta\.reasoning_content are the\n        \/\/ model thinking out loud: never shown, never spoken\./);
});

test('the Companion transcribes on this PC only: no cloud speech fallback', () => {
  const stt = read('companion', 'src', 'stt.js');
  assert.match(stt, /require\('\.\.\/\.\.\/src\/stt-local'\)/);
  assert.doesNotMatch(stt, /openai|gemini|GoogleGenAI/i);
});

test('desktop window gets microphone only, never display-capture', () => {
  const branch = companionIndex.match(/if \(isTrustedDesktopWebContents\(webContents\)\) \{[\s\S]*?return ([^;]+);/);
  assert.ok(branch, 'allowMedia must have a desktop branch');
  assert.match(branch[1], /'microphone'/);
  assert.ok(!branch[1].includes('display-capture'), 'the dashboard must never be granted display-capture');
  assert.match(companionIndex, /TRUSTED_DESKTOP_URL/);
});

test('dashboard mic capture never pins a sample rate', () => {
  assert.ok(!/new AudioContext\(\{\s*sampleRate/.test(appJs), 'no sampleRate pin in the dashboard renderer (Windows driver bug)');
  assert.match(appJs, /getUserMedia/);
  assert.match(appJs, /pcm-processor\.js/);
});

test('knot engine has the speaking state and a voice level input', () => {
  assert.match(knot3d, /speaking:\s*\{/);
  assert.match(knot3d, /setLevel\(/);
  assert.match(knot3d, /trefoilPoint/);
});

test('hero styles carry the speaking accent and trace stars', () => {
  assert.match(stylesCss, /\[data-knot='speaking'\]/);
  assert.match(stylesCss, /\.hero-node\.trace/);
  assert.match(stylesCss, /orbBreathe/);
});

test('voice UI is wired end to end', () => {
  assert.match(indexHtml, /id="voice-toggle"/);
  assert.match(indexHtml, /id="voice-thread"/);
  assert.match(preloadJs, /voiceAsk/);
  assert.match(preloadJs, /onAiEvent/);
  assert.match(mainJs, /'voice:ask'/);
  assert.match(mainJs, /'voice:transcribe'/);
  assert.match(appJs, /function renderVoiceThread/);
  assert.match(appJs, /addVoiceTrace/);
});
