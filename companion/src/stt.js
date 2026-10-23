// Speech-to-text for the Companion: whisper.cpp on this PC (src/stt-local.js),
// nothing else. Local Edition has no cloud fallback, so audio never leaves the
// machine. Returns { text, provider } or { text:'', error }.

function createSTT() {
  let sttLocal = null;
  try { sttLocal = require('../../src/stt-local'); } catch { sttLocal = null; }
  const available = Boolean(sttLocal && sttLocal.status().available);

  return {
    available,
    providers: available ? ['local'] : [],
    async transcribe(pcm) {
      if (!available || !pcm || pcm.length < 3200) return { text: '' };
      try {
        const res = await sttLocal.transcribePcm(pcm);
        if (res.error) return { text: '', error: { message: res.error, code: res.error, provider: 'local' } };
        return { text: res.text || '', provider: 'local' };
      } catch (e) {
        return { text: '', error: { message: (e && e.message) || String(e), provider: 'local' } };
      }
    }
  };
}

module.exports = { createSTT };
