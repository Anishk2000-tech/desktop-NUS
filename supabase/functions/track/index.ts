// =============================================================================
// track: anonymous usage stats -> public.install_events
// =============================================================================
//
// Both Nūs apps POST one small JSON event here (TELEMETRY-CONTRACT.md in the
// Growth OS repo is the contract). Callers are anonymous by design: the
// install id is a random UUID the client made on first launch and never ties
// to an account, so the gateway does not verify a JWT. Instead this function
//   - validates the shape, the event name, the props keys and the props size,
//   - rate-limits to 200 events per install per UTC day (count, then insert),
//   - inserts with the service role, because the table has no client policies,
//   - answers 204 on accept, 400 on a bad shape or name, 429 over the limit.
// The body never carries content: props values are short strings, numbers or
// booleans under allowed keys only, and anything else is dropped with 400.
//
// DEPLOY:  supabase functions deploy track --no-verify-jwt
// SECRETS: none of its own. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
//          injected automatically.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

// Keep these three lists identical to the CHECK constraints in schema.sql and
// to the allowed names and props keys in TELEMETRY-CONTRACT.md.
const PRODUCTS = new Set(['desktop', 'companion']);
const NAMES = new Set([
  'install', 'app_open', 'source_answer', 'first_import', 'import', 'first_ask', 'ask',
  'key_connected', 'companion_session', 'signin', 'limit_hit', 'upgrade_click',
  'checkout_started', 'stats_off',
]);
const PROP_KEYS = new Set([
  'acq_action_id', 'utm_source', 'utm_medium', 'utm_campaign', 'source', 'mode',
  'provider', 'minutes', 'method', 'unit', 'reason', 'os_version', 'locale',
]);
// Dedupe to one per install per UTC day; must match the partial unique index.
const DAILY_UNIQUE = new Set(['app_open']);

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PROPS_BYTES = 1024;
const MAX_PROP_STRING = 80;
const RATE_LIMIT_PER_DAY = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Props = Record<string, string | number | boolean>;

function reply(status: number, body?: unknown) {
  if (body === undefined) return new Response(null, { status, headers: corsHeaders });
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

// Strict, not lenient: a client that sends an unknown key or a nested value is
// a client with a bug, and a 400 is how it finds out. Returns null on any
// violation.
function cleanProps(value: unknown): Props | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Props = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!PROP_KEYS.has(key)) return null;
    if (typeof raw === 'boolean') out[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === 'string') {
      if (raw.length > MAX_PROP_STRING) return null;
      out[key] = raw;
    } else return null;
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > MAX_PROPS_BYTES) return null;
  return out;
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return reply(400, { error: 'too_large' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
  } catch {
    return reply(400, { error: 'bad_json' });
  }

  const installId = shortText(body.install_id, 36);
  if (!installId || !UUID_RE.test(installId)) return reply(400, { error: 'bad_install_id' });
  const product = typeof body.product === 'string' && PRODUCTS.has(body.product) ? body.product : null;
  if (!product) return reply(400, { error: 'bad_product' });
  const name = typeof body.name === 'string' && NAMES.has(body.name) ? body.name : null;
  if (!name) return reply(400, { error: 'bad_name' });
  const props = cleanProps(body.props);
  if (!props) return reply(400, { error: 'bad_props' });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Rate limit: per install, one UTC day window. Count first, then insert.
  const today = utcDay();
  const { count, error: countError } = await admin
    .from('install_events')
    .select('id', { count: 'exact', head: true })
    .eq('install_id', installId.toLowerCase())
    .eq('day', today);
  if (countError) {
    console.error('[track] rate check failed', countError.message);
    return reply(500, { error: 'rate_check_failed' });
  }
  if ((count ?? 0) >= RATE_LIMIT_PER_DAY) return reply(429, { error: 'rate_limited' });

  const row = {
    install_id: installId.toLowerCase(),
    product,
    name,
    app_version: shortText(body.app_version, 40),
    platform: shortText(body.platform, 20),
    props,
    day: today,
  };

  // app_open: one row per install per UTC day, enforced by the partial unique
  // index install_events_one_open_per_day. PostgREST cannot express the index
  // predicate that `on conflict ... where name in ('app_open') do nothing`
  // needs to infer a partial index, so the "do nothing" lives here: a unique
  // violation on a daily-unique name is the expected second open of the day
  // and answers 204 like the first one did.
  const { error } = await admin.from('install_events').insert(row);
  if (error) {
    if (error.code === '23505' && DAILY_UNIQUE.has(name)) return reply(204);
    console.error('[track] insert failed', error.message);
    return reply(500, { error: 'insert_failed' });
  }
  return reply(204);
});
