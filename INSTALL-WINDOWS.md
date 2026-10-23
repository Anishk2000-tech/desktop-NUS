# Nūs Local Edition on Windows 10/11, with LM Studio

This fork of Nūs runs **only on your own models in LM Studio**. There is no Claude,
no Gemini, no API key, no account, no Pro plan, no usage stats and no auto-update.
Syllabus reading, the Ask bar, chat, voice answers and the Companion's screen help
all go to the model you load in LM Studio, and speech is transcribed on your PC by
whisper.cpp. Nothing leaves the laptop. (The exceptions are the one-time downloads
during setup, and Google Calendar or Outlook if you connect them yourself.)

Tuned for: **RTX 3050 4 GB laptop GPU, 32 GB RAM, Ryzen 7**, with **Gemma 4 12B**
as the main model (it reads text *and* the screen). GPT-OSS 20B works too.

---

## 1. Set up LM Studio (once)

1. Open LM Studio > **Discover** (magnifier icon) > search **`gemma 4 12b`** > download
   the **Q4_K_M** GGUF. It's about 7 GB. Check that the model shows the **vision (eye)**
   badge: that means the image projector came with it, and Nūs needs it to see your
   screen.
2. Go to the **Developer** tab (the terminal icon) > **Select a model to load** > Gemma 4 12B.
   Before it loads, open the load settings (the gear, or "Manually choose model load
   parameters") and set:

   | Setting | Value for a 4 GB GPU + 32 GB RAM | Why |
   |---|---|---|
   | **Context Length** | **16384** (8192 if memory is tight) | Long syllabi fit in one pass. The default 4096 is too small; Nūs warns if it sees it. |
   | GPU Offload | LM Studio's suggestion (about 12-18 layers) | 4 GB holds only part of a 12B model; the rest runs from RAM. |
   | Flash Attention | On | Less memory for the context. |
   | Keep Model in Memory | On | Avoids reloading between questions. |
   | CPU Thread Pool Size | 8 | Your CPU's physical cores. |

3. Switch the server **Status** from *Stopped* to **Running**. The address must be
   `http://127.0.0.1:1234`, which is the default.
4. Optional but recommended: in LM Studio's settings, turn on **start the LLM server
   on login** (in some versions it's called "Enable local LLM service"). Then Nūs works
   right after a reboot without opening LM Studio.
5. Optional: under the server settings, turn on **Just-in-Time model loading**.
   Then Nūs can load the model by itself if you forget. The first answer after
   that takes longer.

**What to expect on this laptop:** a 12B model split between a 4 GB GPU and RAM
writes roughly 3-7 words a second. A screen-guidance step takes about 20-60 seconds,
and a syllabus import 1-3 minutes. These are rough estimates; real speed depends on
your settings. If it feels too slow, see "Faster setups" below.

---

## 2. Get Nūs

### Option A: download the ready-made installer (easiest)

Every push to this repository builds Windows installers on GitHub's servers. Each
build is tested there: it installs silently and the installed app boots.

1. On GitHub: **Actions** tab > **build-windows** > the newest green run > **Artifacts**
   > download **Nus-Local-Windows** (a zip).
2. Unzip it and run **`Nus-Setup.exe`**. Windows SmartScreen will say *"Windows
   protected your PC"* because the installer isn't code-signed. Click **More info**,
   then **Run anyway**. It installs only for your user, so no admin rights are needed.
   (`Nus-Portable.exe` runs without installing.)
3. You still need local voice? The installer includes whisper.cpp. Nūs downloads the
   57 MB speech model the first time you click the Knot to talk.

### Option B: build it yourself from this repo

```powershell
git clone https://github.com/Anishk2000-tech/desktop-NUS.git
cd desktop-NUS
git checkout claude/wonderful-volta-wawn68   # until this branch is merged
```

Then double-click **`setup-windows.bat`** in that folder. It will:

1. install Node.js LTS with winget if you don't have it
2. install the app's packages (`npm ci`)
3. download the local speech engine (whisper.cpp + English model)
4. ask whether to **[1] build and run the installer**, or **[2] run straight from the
   folder** with a "Nus Local" shortcut on the Desktop and in the Start menu
5. check that LM Studio answers, and start its server with `lms` if it can

If the installer build fails with *"Cannot create symbolic link: A required privilege
is not held by the client"*, that's Windows blocking a step of electron-builder.
The script then falls back to option [2] on its own. To get the installer, turn on
**Settings > Update & Security > For developers > Developer Mode** (or run the script
from an Administrator terminal) and run it again.

Manual equivalent: `npm ci`, then `npm run setup:voice`, then `npm start` (run) or
`npm run dist` (installer in `dist\`).

**Updating later:** `git pull`, then run `setup-windows.bat` again. Your semester data
is kept.

---

## 3. First run

1. Nūs opens on **Today**. Go to **Settings > Local AI** (the first card).
2. It should say **Connected · google/gemma-4-12b** with your context length. Press
   **Test chat**, then **Test vision**. The vision test shows the model a red square
   and checks that it says "red".
3. Leave both models on **Auto** if Gemma is loaded. Auto picks the loaded model, and
   Gemma does both jobs. To use GPT-OSS for text, pick it as **Chat model** and keep
   Gemma as **Vision model**. GPT-OSS can't see, so screenshots always go to the
   vision model.
4. **Advanced** (in the same card):
   - **Wait limit**: 300 s by default. This is the longest silence allowed from LM Studio.
   - **Screenshot size**: 1280 px by default. Lower it to 1024 for faster screen help.
   - **Context length**: leave it at 0 and Nūs reads it from LM Studio.
   - **API token**: only if you turned on authentication in LM Studio's server.
5. **Voice:** on Today, click the Knot and accept the one-time voice model download.
   After that, talk. Whisper transcribes on your PC and Gemma answers. Windows asks
   for microphone permission once.

The same LM Studio settings are also in the floating Knot's **gear** icon.

---

## 4. Using it

| | |
|---|---|
| **Import a syllabus** | **Import** (top bar) > PDF / DOCX / TXT. Gemma reads it into a review table. Nothing is saved until you confirm. Long syllabi are read in parts that fit the context, then merged. |
| **Ask bar** | "push the calc homework to Friday", "add task: lab report due 2026-11-02". Nūs proposes the exact change, and you confirm. |
| **Chat** | Knot > Companion: a running thread over your semester. |
| **Point and ask** | Hover any control on screen and press **Ctrl+Shift+T**, then type a question. Gemma looks at the screenshot. |
| **Walk me through it** | Click the Knot and type a task ("add a chart in Excel"). A strand points at each control, one step at a time. |
| **Push to talk** | Hold **Ctrl+Alt+Space** and speak to the Knot. |
| **What should I do?** | **Ctrl+Enter** from anywhere. This answer is instant and needs no model. Turn on "Answer with the local AI" in the gear for a model-written answer. |
| Hide / show, panic | **Ctrl+Shift+Space**, **Ctrl+Shift+X** |

---

## 5. Faster setups for a 4 GB GPU

| Setup | Chat model | Vision model | Trade-off |
|---|---|---|---|
| **Default** | Gemma 4 12B | (same) | Best quality on one model; slowest on 4 GB. |
| **Snappy** | Gemma 4 **E4B** | (same) | About 4.5 GB, mostly on the GPU, so much faster. Weaker on long syllabi and multi-step reasoning. |
| **Text speed** | GPT-OSS 20B | Gemma 4 12B | GPT-OSS is a mixture-of-experts model, so text is quick even from RAM. Its thinking is hidden. Both models loaded use about 20 GB of RAM; LM Studio may swap them. |

Other speed-ups: Context 8192 instead of 16384, Screenshot size 1024, close the browser
while using screen guidance.

---

## 6. Troubleshooting

| Nūs says | Fix |
|---|---|
| *LM Studio is not answering at http://127.0.0.1:1234* | LM Studio > Developer > server **Running**. If you changed the port, put the new address in Settings > Local AI. |
| *running but no model is loaded* | Load Gemma 4 12B in the Developer tab (or turn on JIT loading). |
| *too long for the context length* | Reload the model with **Context Length 16384**. |
| *could not load the model* | Not enough memory: close apps, lower GPU Offload, or use Context 8192 / Gemma 4 E4B. |
| Test vision fails / *needs a model that can see* | The model has no vision projector. Re-download a Gemma 4 GGUF that shows the vision badge, or pick one under Vision model. |
| *took too long* | Raise **Wait limit**, or use a faster setup (section 5). |
| Voice: *engine is missing* | From source: `npm run setup:voice`, then restart Nūs. |
| SmartScreen warning | Unsigned build: **More info > Run anyway**. |

- Logs: AI errors go to `%APPDATA%\Nus\ai-errors.log`. When running from the folder
  with plain `npm start`, they go to `%APPDATA%\nus-desktop\` instead. The "Nus Local"
  shortcut uses `%APPDATA%\Nus`, so it shares data with the installed app.
- Your data: `%APPDATA%\Nus\data\nus.db`. Delete it to start over.
- Try Nūs without LM Studio: `node scripts/mock-lmstudio.js` starts a fake LM Studio on
  port 1234 with canned answers.

---

## What changed from upstream Nūs

- All AI goes through `src/local-llm.js` (an LM Studio client). It does model discovery,
  automatic model choice, vision routing, JSON-schema output, hides thinking text, and
  turns errors into plain fixes.
- Free-plan caps, sign-in, Stripe, anonymous stats and the auto-updater are gone. The
  auto-updater would have replaced this build with the upstream cloud one.
- `src/config.js` is optional. Upstream crashed on a fresh clone without it.
  Google Calendar and Outlook still work if you create your own OAuth clients
  (`docs/credentials-needed.md`, sections 2-3).
- The Companion transcribes with whisper.cpp only (no cloud speech fallback).
