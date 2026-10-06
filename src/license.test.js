const { test } = require('node:test');
const assert = require('node:assert');
const { createLicense, OFFLINE_GRACE_MS } = require('./license');

function harness({ now = Date.parse('2026-08-21T12:00:00Z'), response, cache } = {}) {
  let savedCache = cache ? JSON.stringify(cache) : null;
  const cacheStore = {
    get: () => savedCache,
    set: (value) => { savedCache = value; },
  };
  const auth = {
    getUser: () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    getAccessToken: () => 'user-jwt',
  };
  const config = {
    supabase: { url: 'https://project.supabase.co', anonKey: 'publishable' },
    isSupabaseConfigured: () => true,
  };
  const fetchImpl = async () => response || {
    ok: true,
    json: async () => [{
      status: 'active', is_pro: true,
      current_period_end: new Date(now + 86400000).toISOString(),
      cancel_at_period_end: false,
    }],
  };
  return {
    license: createLicense({ auth, config, cacheStore, fetchImpl, clock: () => now }),
    readCache: () => JSON.parse(savedCache || 'null'),
    corruptCache: (value) => { savedCache = value; },
  };
}

test('a live future entitlement grants Pro and is cached', async () => {
  const { license, readCache } = harness();
  const state = await license.refresh();
  assert.equal(state.isPro, true);
  assert.equal(state.source, 'online');
  assert.equal(readCache().userId, '11111111-1111-4111-8111-111111111111');
});

test('an active row with no period end fails closed', async () => {
  const response = { ok: true, json: async () => [{ status: 'active', is_pro: true, current_period_end: null }] };
  const { license } = harness({ response });
  assert.equal((await license.refresh()).isPro, false);
});

test('a recent cache grants a short offline grace period', async () => {
  const now = Date.parse('2026-08-21T12:00:00Z');
  const cache = {
    userId: '11111111-1111-4111-8111-111111111111',
    isPro: true,
    plan: 'pro',
    checkedAt: new Date(now - OFFLINE_GRACE_MS + 1000).toISOString(),
    currentPeriodEnd: new Date(now + 86400000).toISOString(),
  };
  const response = { ok: false, status: 503, json: async () => ({}) };
  const { license } = harness({ now, response, cache });
  const state = await license.refresh();
  assert.equal(state.isPro, true);
  assert.equal(state.source, 'offline_cache');
});

test('expired cache never grants Pro', async () => {
  const now = Date.parse('2026-08-21T12:00:00Z');
  const cache = {
    userId: '11111111-1111-4111-8111-111111111111',
    isPro: true,
    checkedAt: new Date(now - OFFLINE_GRACE_MS - 1).toISOString(),
    currentPeriodEnd: new Date(now + 86400000).toISOString(),
  };
  const response = { ok: false, status: 503, json: async () => ({}) };
  const { license } = harness({ now, response, cache });
  assert.equal((await license.refresh()).isPro, false);
});

test('a corrupt secure cache fails closed', async () => {
  const response = { ok: false, status: 503, json: async () => ({}) };
  const { license, corruptCache } = harness({ response });
  corruptCache('{not valid json');
  assert.equal((await license.refresh()).isPro, false);
});

test('Checkout accepts only a Stripe HTTPS URL', async () => {
  const response = { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/test' }) };
  const { license } = harness({ response });
  assert.match((await license.createCheckout()).url, /^https:\/\/checkout\.stripe\.com/);

  const bad = harness({ response: { ok: true, json: async () => ({ url: 'https://evil.example/checkout' }) } });
  assert.equal((await bad.license.createCheckout()).error, 'checkout_unavailable');
});

test('the billing portal accepts only a Stripe HTTPS URL and needs a session', async () => {
  const response = { ok: true, json: async () => ({ url: 'https://billing.stripe.com/p/session/test' }) };
  const { license } = harness({ response });
  assert.match((await license.createPortal()).url, /^https:\/\/billing\.stripe\.com/);

  const bad = harness({ response: { ok: true, json: async () => ({ url: 'http://billing.stripe.com/p/session/test' }) } });
  assert.equal((await bad.license.createPortal()).error, 'portal_unavailable');

  const missing = harness({ response: { ok: false, status: 404, json: async () => ({ error: 'no_subscription' }) } });
  assert.equal((await missing.license.createPortal()).error, 'no_subscription');
});

test('server error codes pass through Checkout so the UI can explain them', async () => {
  const configured = harness({ response: { ok: false, status: 503, json: async () => ({ error: 'billing_not_configured' }) } });
  assert.equal((await configured.license.createCheckout()).error, 'billing_not_configured');
});

test('the license module no longer writes funnel events keyed on the user', () => {
  // Usage stats moved to src/stats.js on a random install id (v0.2.7), so
  // anonymous installs count and public.events has no writer left.
  const auth = { getUser: () => ({ id: 'u1' }), getAccessToken: () => 'jwt' };
  const config = { supabase: { url: 'https://project.supabase.co', anonKey: 'publishable' }, isSupabaseConfigured: () => true };
  const license = createLicense({ auth, config, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(typeof license.track, 'undefined');
  const source = require('fs').readFileSync(require('path').join(__dirname, 'license.js'), 'utf8');
  assert.doesNotMatch(source, /rest\/v1\/events/, 'no direct insert into public.events');
});
