# Anonymous usage stats

Since v0.2.7 Nūs Desktop sends anonymous usage stats: which features get used,
on a random install id. Your coursework and what you type stay on your device.
Turn it off in Settings.

## What is sent

One small JSON event at a time, over HTTPS, to the `track` function of the
Nūs Supabase project. There is no account, token or email on it.

```json
{
  "install_id": "8f3c...-uuid-v4",
  "product": "desktop",
  "name": "app_open",
  "app_version": "0.2.7",
  "platform": "win32",
  "props": {"acq_action_id": "act-...", "source": "instagram"}
}
```

| name | when |
|---|---|
| `install` | the first launch ever on this install id |
| `app_open` | once per start, and once per calendar day while Nūs stays in the tray |
| `source_answer` | the one-click "Where did you hear about Nūs?" answer (Instagram, a friend, Reddit, X, YouTube, search, other, or skipped) |
| `first_import` | the first syllabus you confirmed on this install |
| `import` | later confirmed syllabus imports |
| `first_ask` | the first question or voice command Nūs answered |
| `ask` | later asks, with the mode: voice, text or guide |
| `key_connected` | you saved an AI key, with the provider name (never the key) |
| `companion_session` | a Companion session ended, with its length in whole minutes |
| `signin` | you signed in, with the method: google or email |
| `limit_hit` | a Free cap was reached, with which one |
| `upgrade_click` | you opened the upgrade sheet, with where from |
| `checkout_started` | Stripe Checkout opened |
| `stats_off` | you turned stats off; the last event this install ever sends |

`props` only ever carries these keys: `acq_action_id`, `utm_source`,
`utm_medium`, `utm_campaign` (the optional setup code's campaign labels),
`source`, `mode`, `provider`, `minutes`, `method`, `unit`, `reason`,
`os_version`, `locale`. Values are short labels, numbers or booleans. The
server drops anything else. Nothing you type, no file names, no course names,
no email, no account id.

## Where the install id lives

`install_id.txt` in the Nūs data folder:

- Windows: `%APPDATA%\Nus\install_id.txt`
- Mac: `~/Library/Application Support/Nus/install_id.txt`

It is a random UUID made on first launch. It is never tied to your email or
account on this machine. Delete the file and the link to everything sent so
far is gone; the next launch makes a fresh id and counts as a new install.

## How to turn it off

Settings, the "Send anonymous usage stats" card, switch it off. Nūs sends one
final `stats_off` event and then nothing, ever, until you switch it back on.
The same switch is on the first onboarding screen.

Other ways it stays silent:

- `NUS_STATS=0` in the environment disables it completely (tests, smoke runs,
  CI). No `stats_off` is sent either; nothing is.
- Unpackaged dev runs (`npm start`) send nothing unless `NUS_STATS=1`.
- `--smoke` runs never send.

## How sending behaves

Every send is fire-and-forget: a 4 second timeout, at most one retry, and every
failure is swallowed. Nothing waits on it, nothing is logged to you, and the
app behaves identically offline.

## Server side

The `track` function validates the shape, the event name, the props keys and
the props size (1 KB), rate-limits to 200 events per install per UTC day, and
inserts into `public.install_events` with the service role. The table has row
level security on and no policies, so no client can read or write it. The
`daily-metrics` function returns per-day counts (never rows) to the Growth OS
behind a bearer token. Schema: `supabase/schema.sql`, section
"install_events". Contract: `TELEMETRY-CONTRACT.md` in the Growth OS repo.
