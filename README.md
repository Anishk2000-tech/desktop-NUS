# Nūs Desktop: Local Edition

The semester organizer that runs on your own AI, on your own machine. Import a
real syllabus, see your whole semester as a living map, and let Nūs propose the
next move. Nothing is saved without your review.

**This edition runs only on LM Studio.** Every AI feature (syllabus reading, the
Ask bar, chat, voice answers, and the Companion's screen help) goes to the model
you load in [LM Studio](https://lmstudio.ai) on this PC. Speech is transcribed
locally by whisper.cpp. There are no API keys, no account, no Free/Pro caps, no
usage stats and no auto-update. Nothing leaves your computer except integrations
you connect yourself.

**Windows setup, step by step: [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).**

## Your AI: LM Studio

1. In LM Studio, load **Gemma 4 12B** (it reads text *and* screenshots) with
   **Context Length 16384**, and switch the server on (Developer tab, port 1234).
2. In Nūs, open **Settings > Local AI** and press **Test chat** and **Test vision**.

Both models default to **Auto** (whatever LM Studio has loaded). You can split
them, for example **GPT-OSS 20B** for chat with Gemma as the vision model. A
screenshot always goes to the model that can see. Answers from reasoning models
arrive without their thinking. The Knot's gear icon edits the same settings.

## Install and run

Download `Nus-Setup.exe` from this repository's **Actions > build-windows >
Artifacts** (every push builds and test-installs it on a clean Windows runner),
or build it yourself:

```
setup-windows.bat        (Windows: Node check, packages, voice engine, installer)
```

or by hand:

```
npm install
npm run setup:voice
npm start
```

`npm test` runs the full assertion suite. `npm run smoke` boots and exits.
`npm run tour` replays the walkthrough. `npm run dist` builds the installers.
`npm run setup:voice` downloads the local speech engine (whisper.cpp plus the
base English model, about 65 MB, once) into `vendor/`. The installers bundle the
engine and fetch the model on first use, so only source builds need this step.
`node scripts/mock-lmstudio.js` starts a fake LM Studio with canned answers, so
you can try Nūs without a model.

### Why Windows warns you about the download

The installer is not code signed, so SmartScreen shows **"Windows protected your
PC", Publisher: Unknown publisher** the first time you run `Nus-Setup.exe`. That
is the absence of a certificate, not a detection. Click **More info**, then
**Run anyway**.

## What's inside

- **Today**: your dashboard. The Ask bar takes plain requests ("push the calc
  homework to Friday", "email my professor about an extension") and proposes
  the exact change before anything is written.
- **Voice**: click the Knot on Today and just talk. Speech to text runs locally
  with whisper.cpp, so no key is needed and no audio leaves your computer. Your
  words and the streamed reply appear under the Knot, which lights up as it
  listens, thinks, and speaks. Files Nūs reads while thinking surface as stars
  on the constellation. Talking over a spoken reply interrupts it.
- **Map**: every course, source, and open task as a draggable knowledge graph.
- **Calendar / Smart tasks / Semester**: deadlines, task breakdowns with
  review, GPA projection that never guesses missing weights.
- **Knot**: the Companion pane and a persistent chat thread that can create
  tasks, move dates, and draft emails, each with a confirm step.
- **Email**: a professor-email drafter that works with no connection at all.
  Add your sending addresses and any draft opens pre-filled in Gmail with
  **Open in Gmail** (no Gmail account connection needed). Outlook connects
  read-only for the inbox brief and your writing style; sending through
  Outlook is a separate opt-in.

## The Companion

The Knot floats on your desktop, keeps running after you close the dashboard,
and comes back from the tray. **Turn off Companion** on the Knot pane removes
it completely and releases the hotkeys until you turn it back on.

Click the Knot and type what you need ("show me how to add a chart"), or hold
the push-to-talk key (`Ctrl+Alt+Space`) and say it. Screen reading uses your LM
Studio vision model (Gemma 4); screenshots are shrunk to 1280 px JPEG first,
which keeps a step quick on a small GPU. The Knot reads the screen once, a strand runs
to the one control to click, and a bubble at the tip says the step. Click it
and the Knot re-reads the screen for the next step; Esc winds it back. When
the task is done you can Keep the steps, and the same ask in the same app
replays them without a model call.

Point at a button, an error, or any spot on the Knot's display and press
`Ctrl+Shift+T`: the strand runs to that control, you type a question about it,
and the answer lands at the tip with "Walk me through it" to turn it into a
step-by-step guide. Sensitive fields such as password boxes are refused.
Pointing works on the display the Knot lives on; other monitors are next.

| Keys | Action |
|---|---|
| `Ctrl+Shift+T` (Windows) | Point at what you need help with |
| `Ctrl+Shift+Space` (`⌘⇧Space` on a Mac) | Hide or show the overlay |
| `Ctrl+Shift+X` (`⌘⇧X`) | Panic: stop listening and vanish |
| `Ctrl+Enter` (`⌘Enter`) | What should I do? (rebindable in Companion settings) |

The overlay is concealed from screen sharing and recordings: the Knot, the
strand and the bubbles do not appear in what you share. Follow the rules of
every meeting, class, interview, or assessment you are in.

## Privacy

Local-first, and in this edition local-only. The database lives at
`%APPDATA%\Nus\data\nus.db` (`~/Library/Application Support/Nus/data/nus.db` on
a Mac). Every AI request, screenshots included, goes to LM Studio on this PC;
voice is transcribed on this PC. There is no account, no telemetry, no
auto-update and no cloud sync. The only outbound calls are the integrations you
explicitly connect (Google Calendar, Outlook) and the one-time voice model
download.

## Stack

Electron, vanilla JS, sql.js (WASM SQLite). One process, two windows: the
Companion overlay ships inside the app, so there is one installer, one
settings store, one runtime.

## License

MIT. See [LICENSE](LICENSE).

`src/config.js` is optional and gitignored: without it Nūs starts with every
integration "not configured". To use Google Calendar or Outlook, create your own
OAuth clients and put them there; `docs/credentials-needed.md` (sections 2 and 3)
walks through it. `src/shipped-secrets.test.js` fails the build if a genuinely
confidential credential ever lands in a packaged file.

Based on Nūs Desktop by Pranav Desu (MIT).
