// The Companion's model: LM Studio on this PC, the same server and models the
// desktop app uses (src/ai.js owns the one client, so both halves share its
// model list cache and settings).
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>
// complete({ system, turns, imageDataUrl, maxTokens, json, schema }) -> Promise<text>
//
// A screenshot always goes to the vision model (the chat model itself when it
// can see, which Gemma can). Errors are LocalAIError with a sentence the
// overlay can show as is.

function toMessages(turns) {
  return (turns || []).map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.text || '') }));
}

function createLLM(settings) {
  const { client, getConfig } = require('../../src/ai');
  const cfg = getConfig();
  return {
    provider: 'lmstudio',
    model: cfg.chatModel || 'loaded model',
    // Always "ready": there is no key to be missing. Whether LM Studio is
    // actually running is only known by asking, and the error says what to do.
    ready: true,
    async stream(params) {
      const result = await client.chat({
        system: params.system,
        messages: toMessages(params.turns),
        imageDataUrl: params.imageDataUrl || null,
        maxTokens: params.maxTokens || 1200,
        stream: true,
        onToken: params.onToken,
        signal: params.signal,
      });
      return result.text;
    },
    async complete(params) {
      const result = await client.chat({
        system: params.system,
        messages: toMessages(params.turns),
        imageDataUrl: params.imageDataUrl || null,
        maxTokens: params.maxTokens || 512,
        temperature: params.temperature != null ? params.temperature : 0.2,
        schema: params.schema,
        schemaName: params.schemaName,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      });
      // With a schema the client already parsed the object; hand back JSON
      // text so callers' tolerant parsers keep working unchanged.
      if (params.schema && result.json) return JSON.stringify(result.json);
      return result.text;
    },
  };
}

module.exports = { createLLM };
