# 🎙️ pi-live-voice

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Pi Extension](https://img.shields.io/badge/Pi-Coding%20Agent%20Extension-blueviolet)](#install)
[![Groq Whisper](https://img.shields.io/badge/STT-Groq%20Whisper%20v3-orange)](https://console.groq.com)

**Claude Code-style live voice dictation for the [Pi Coding Agent](https://github.com/earendil-works/pi).**

Speak naturally and watch your prompt type itself in real time—complete with a live microphone waveform meter, dual-pass Groq Whisper accuracy, multilingual auto-detection (English, Hindi, and 50+ languages), and project-aware coding vocabulary.

```text
🎙️  ● ▂▄▆█▆▃▂▅  listening… (0:06) — ALT+V to finish · Esc/Ctrl+C to cancel
> refactor the auth middleware to use the new token validation helper█
```

---

## ✨ Features

* **Live Streaming Preview:** Streams 16 kHz PCM audio in memory and sends rolling snapshots to `whisper-large-v3-turbo` so words appear directly inside your Pi editor as you speak.
* **Two-Pass Accuracy:** Uses `whisper-large-v3-turbo` for instant live feedback, then runs a final clean pass with `whisper-large-v3` when you stop.
* **Real-Time Mic Waveform:** Animated terminal level meter (`▁▂▃▄▅▆▇█`) with `listening…` / `transcribing…` status and elapsed timer.
* **Project-Aware Vocabulary:** Automatically feeds your current project folder name and active Git branch into Whisper prompt hints so technical terms and identifiers transcribe accurately.
* **Clean Cancel & Restore:** Pressing `Esc` or `Ctrl+C` while recording or finalizing aborts any in-flight request and restores the exact prompt text you had before starting.
* **Cross-Platform Audio Capture:** Auto-detects `pw-record` (PipeWire / Linux), `arecord` (ALSA / Linux), or `rec` (SoX / macOS & Linux) with zero temporary audio files written to disk.
* **Privacy-Friendly:** Works seamlessly with GroqCloud's **Zero Data Retention (ZDR)** setting—audio stays in memory and is never logged.

---

## 🚀 Install

### Option 1: Install directly via Pi

```bash
pi install [https://github.com/debarch777/pi-live-voice](https://github.com/debarch777/pi-live-voice)
```

### Option 2: Manual drop-in

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL [https://raw.githubusercontent.com/debarch777/pi-live-voice/main/extensions/voice-dictation.ts](https://raw.githubusercontent.com/debarch777/pi-live-voice/main/extensions/voice-dictation.ts) \
  -o ~/.pi/agent/extensions/voice-dictation.ts
```

Then run **`/reload`** inside Pi.

---

## 🔑 Setup

1. Get a free API key from [GroqCloud](https://console.groq.com/keys) *(tip: enable **Zero Data Retention** under Settings → Data Controls)*.  
2. Provide your key in either way:
   * **Environment variable:**
     ```bash
     export GROQ_API_KEY="gsk_..."
     ```
   * **Or directly inside Pi:**
     ```text
     /voice key gsk_...
     ```
     *(Saved locally to `~/.pi/agent/voice-dictation.json` with `chmod 600`.)*

### Audio Prerequisite

You need one of the following CLI recorders installed:
* **Linux (PipeWire):** `pw-record` *(pre-installed on most modern distros)*
* **Linux (ALSA):** `arecord` (`alsa-utils`)
* **macOS:** `rec` (`brew install sox`)

---

## ⌨️ Usage

| Action | Shortcut / Command |
| :--- | :--- |
| **Start / Stop & Finalize** | `Alt+V` or `/voice` |
| **Cancel & Restore Prompt** | `Esc` or `Ctrl+C` |
| **Set Groq API Key** | `/voice key <gsk_...>` |
| **Switch Final Model** | `/voice model whisper-large-v3` or `whisper-large-v3-turbo` |
| **Lock / Auto-Detect Language** | `/voice lang en`, `/voice lang hi`, `/voice lang auto` |
| **Check Status & Recorder** | `/voice status` |

---

## ⚙️ Configuration

Optional config lives at `~/.pi/agent/voice-dictation.json`:

```json
{
  "groqApiKey": "",
  "model": "whisper-large-v3",
  "liveModel": "whisper-large-v3-turbo",
  "language": "",
  "shortcut": "alt+v",
  "prompt": "Pi coding agent, TypeScript, Python, Linux, CLI, API, JSON, git, bash",
  "liveIntervalMs": 1400,
  "maxDurationSec": 120,
  "recorder": "auto"
}
```

---

## 📄 License

[MIT](LICENSE)
