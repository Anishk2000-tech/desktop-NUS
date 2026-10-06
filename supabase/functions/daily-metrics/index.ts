// =============================================================================
// daily-metrics: the Growth OS pull of pre-aggregated usage stats
// =============================================================================
//
// GET ?since=YYYY-MM-DD returns completed UTC days only (day < current_date)
// as a JSON list in exactly the shape growth_os/metrics_pull.py imports:
//
//   [{"day":"2026-10-06","product":"desktop","action_id":"","event_name":"app_open","event_count":41,"value":null}]
//
// The rollup itself is public.install_daily_metrics(since) in schema.sql, run
// with the service role (the function is revoked from anon and authenticated,
// and install_events has no client policies). This endpoint only guards and
// reshapes.
//
// Auth: the gateway does not verify a JWT (the puller has no Supabase user).
// Every request must carry `Authorization: Bearer <METRICS_TOKEN>`, compared
// in constant time against the function secret. No token, no rows.
//
// DEPLOY:  supabase functions deploy daily-metrics --no-verify-jwt
// SECRETS: METRICS_TOKEN (long random string; the same value goes in the
//          Growth OS data/metrics_endpoint.json)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const DEFAULT_WINDOW_DAYS = 60;
const MAX_WINDOW_DAYS = 400;

type MetricRow = {
  day: string;
  product: string;
  action_id: string;
  event_name: string;
  event_count: number;
  value: number | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// `since` is a plain calendar date. Anything else, or anything further back
// than the cap, falls to the default window rather than erroring: the puller
// runs unattended and a bad parameter should still return something sane.
function parseSince(value: string | null): string {
  const today = new Date();
  const fallback = new Date(today.getTime() - DEFAULT_WINDOW_DAYS * 86400000);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return utcDateString(fallback);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || utcDateString(parsed) !== value) return utcDateString(fallback);
  const floor = new Date(today.getTime() - MAX_WINDOW_DAYS * 86400000);
  if (parsed.getTime() < floor.getTime()) return utcDateString(floor);
  return value;
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const expected = Deno.env.get('METRICS_TOKEN') || '';
  const authorization = req.headers.get('Authorization') || '';
  const given = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!expected || !given || !constantTimeEqual(given, expected)) return json({ error: 'unauthorized' }, 401);

  const since = parseSince(new URL(req.url).searchParams.get('since'));

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data, error } = await admin.rpc('install_daily_metrics', { since });
  if (error) {
    console.error('[daily-metrics] rollup failed', error.message);
    return json({ error: 'rollup_failed' }, 500);
  }

  // Reshape explicitly so the wire format never drifts with the SQL function
  // (bigint can arrive as a string, dates as timestamps, extra columns later).
  const rows: MetricRow[] = (Array.isArray(data) ? data : []).map((r: Record<string, unknown>) => ({
    day: String(r.day ?? '').slice(0, 10),
    product: String(r.product ?? ''),
    action_id: String(r.action_id ?? ''),
    event_name: String(r.event_name ?? ''),
    event_count: Number(r.event_count ?? 0),
    value: r.value === null || r.value === undefined ? null : Number(r.value),
  }));
  return json(rows);
});
