import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface VoiceConfig {
  groqApiKey: string;
  model: string;
  liveModel: string;
  language: string;
  shortcut: string;
  prompt: string;
  liveIntervalMs: number;
  maxDurationSec: number;
  recorder?: "auto" | "pw-record" | "arecord" | "rec";
}

interface RecorderSpec {
  cmd: string;
  args: string[];
  name: string;
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "voice-dictation.json");
const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // 16-bit mono
const METER_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

const DEFAULT_CONFIG: VoiceConfig = {
  groqApiKey: process.env.GROQ_API_KEY || "",
  model: "whisper-large-v3",
  liveModel: "whisper-large-v3-turbo",
  language: "",
  shortcut: "alt+v",
  prompt: "Pi coding agent, TypeScript, Python, Linux, macOS, CLI, API, JSON, git, bash, regex, OAuth, localhost",
  liveIntervalMs: 1400,
  maxDurationSec: 120,
  recorder: "auto",
};

function loadConfig(): VoiceConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        groqApiKey: raw.groqApiKey || process.env.GROQ_API_KEY || "",
      };
    }
  } catch {
    // Fall back to defaults
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg: VoiceConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveRecorder(preferred?: string): RecorderSpec | null {
  const candidates: RecorderSpec[] = [
    {
      name: "pw-record",
      cmd: "pw-record",
      args: ["--rate", String(SAMPLE_RATE), "--channels", "1", "--format", "s16", "-"],
    },
    {
      name: "arecord",
      cmd: "arecord",
      args: ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw", "-"],
    },
    {
      name: "rec",
      cmd: "rec",
      args: ["-q", "-r", String(SAMPLE_RATE), "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"],
    },
  ];

  if (preferred && preferred !== "auto") {
    const match = candidates.find((c) => c.name === preferred);
    if (match && commandExists(match.cmd)) return match;
  }

  for (const c of candidates) {
    if (commandExists(c.cmd)) return c;
  }
  return null;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function buildWavFromPcm(pcm: Buffer): Buffer {
  const raw = pcm.length >= 44 && pcm.subarray(0, 4).toString("ascii") === "RIFF" ? pcm.subarray(44) : pcm;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + raw.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SEC, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(raw.length, 40);
  return Buffer.concat([header, raw]);
}

function computeRms(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = chunk.readInt16LE(i * 2) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

function renderMeter(level: number, history: number[]): string {
  const bars = history.map((v) => {
    const idx = Math.min(METER_BLOCKS.length - 1, Math.floor(Math.min(1, v * 5.5) * METER_BLOCKS.length));
    return METER_BLOCKS[idx];
  });
  const liveIdx = Math.min(METER_BLOCKS.length - 1, Math.floor(Math.min(1, level * 5.5) * METER_BLOCKS.length));
  return bars.join("") + METER_BLOCKS[liveIdx];
}

function getProjectHint(cwd?: string): string {
  const dir = cwd || process.cwd();
  const hints: string[] = [];
  const projectName = path.basename(dir);
  if (projectName) hints.push(projectName);
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 300,
    })
      .toString()
      .trim();
    if (branch && branch !== "HEAD") hints.push(branch);
  } catch {
    // Not a git repo
  }
  return hints.join(", ");
}

function composeEditorText(base: string, spoken: string): string {
  const clean = spoken.trim();
  if (!clean) return base;
  if (!base) return clean;
  const spacer = base.endsWith(" ") || base.endsWith("\n") ? "" : " ";
  return base + spacer + clean;
}

export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  let recorderProc: ChildProcess | null = null;
  let pcmChunks: Buffer[] = [];
  let totalPcmBytes = 0;
  let lastTranscribedBytes = 0;
  let recordingStartedAt = 0;
  let baseEditorText = "";
  let latestLiveText = "";
  let currentRms = 0;
  let meterHistory: number[] = Array(7).fill(0);
  let hasDetectedSpeech = false;
  let projectHint = "";

  let uiInterval: ReturnType<typeof setInterval> | null = null;
  let liveInterval: ReturnType<typeof setInterval> | null = null;
  let liveInFlight = false;
  let isFinalizing = false;
  let activeAbort: AbortController | null = null;
  let activeCtx: ExtensionContext | null = null;
  let cancelUnsubscribe: (() => void) | null = null;

  function clearTimersAndHooks(ctx: ExtensionContext | null) {
    if (uiInterval) {
      clearInterval(uiInterval);
      uiInterval = null;
    }
    if (liveInterval) {
      clearInterval(liveInterval);
      liveInterval = null;
    }
    if (cancelUnsubscribe) {
      cancelUnsubscribe();
      cancelUnsubscribe = null;
    }
    if (ctx?.hasUI) {
      ctx.ui.setStatus("voice-dictation", undefined);
      ctx.ui.setWidget("voice-dictation", undefined);
    }
  }

  function resetState() {
    pcmChunks = [];
    totalPcmBytes = 0;
    lastTranscribedBytes = 0;
    latestLiveText = "";
    currentRms = 0;
    meterHistory = Array(7).fill(0);
    hasDetectedSpeech = false;
    liveInFlight = false;
  }

  function updateRecordingUI(ctx: ExtensionContext) {
    if (!ctx.hasUI || !recorderProc) return;
    const elapsedMs = Date.now() - recordingStartedAt;
    const elapsed = formatElapsed(elapsedMs);
    const meter = renderMeter(currentRms, meterHistory);
    const stateTag = liveInFlight ? "transcribing…" : "listening…";
    ctx.ui.setStatus("voice-dictation", `● ${meter} ${elapsed}`);
    ctx.ui.setWidget("voice-dictation", [
      `🎙️  ● ${meter}  ${stateTag} (${elapsed}) — ${config.shortcut.toUpperCase()} to finish · Esc/Ctrl+C to cancel`,
    ]);

    if (elapsedMs >= config.maxDurationSec * 1000) {
      void stopAndFinalize(ctx);
    }
  }

  async function callGroqWhisper(wavBuffer: Buffer, model: string, signal?: AbortSignal): Promise<string> {
    if (!config.groqApiKey) {
      throw new Error(`Missing Groq API key. Set GROQ_API_KEY or add groqApiKey to ${CONFIG_PATH}`);
    }
    const form = new FormData();
    form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "dictation.wav");
    form.append("model", model);
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (config.language && config.language !== "auto") {
      form.append("language", config.language);
    }
    const fullPrompt = [config.prompt, projectHint].filter(Boolean).join(", ");
    if (fullPrompt) {
      form.append("prompt", fullPrompt);
    }

    const res = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
      body: form,
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Groq API error (${res.status}): ${errText.slice(0, 180)}`);
    }

    const data = (await res.json()) as { text?: string };
    return (data.text || "").trim();
  }

  async function runLivePreview(ctx: ExtensionContext) {
    if (!recorderProc || liveInFlight || isFinalizing) return;
    if (!hasDetectedSpeech || totalPcmBytes - lastTranscribedBytes < BYTES_PER_SEC * 0.5) return;

    liveInFlight = true;
    const snapshotBytes = totalPcmBytes;
    const pcmSnapshot = Buffer.concat(pcmChunks);
    const controller = new AbortController();
    activeAbort = controller;

    try {
      const wav = buildWavFromPcm(pcmSnapshot);
      const text = await callGroqWhisper(wav, config.liveModel || "whisper-large-v3-turbo", controller.signal);
      if (!recorderProc || controller.signal.aborted) return;
      lastTranscribedBytes = snapshotBytes;
      if (text && text !== latestLiveText) {
        latestLiveText = text;
        if (ctx.hasUI) {
          ctx.ui.setEditorText(composeEditorText(baseEditorText, latestLiveText));
        }
      }
    } catch {
      // Ignore transient live preview errors; final pass handles completion
    } finally {
      if (activeAbort === controller) activeAbort = null;
      liveInFlight = false;
    }
  }

  function cancelRecording(ctx: ExtensionContext | null) {
    const proc = recorderProc;
    recorderProc = null;
    isFinalizing = false;
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    clearTimersAndHooks(ctx);
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }
    if (ctx?.hasUI) {
      ctx.ui.setEditorText(baseEditorText);
      ctx.ui.notify("Voice dictation cancelled", "info");
    }
    resetState();
  }

  async function stopAndFinalize(ctx: ExtensionContext) {
    const proc = recorderProc;
    if (!proc || isFinalizing) return;

    recorderProc = null;
    isFinalizing = true;
    if (uiInterval) {
      clearInterval(uiInterval);
      uiInterval = null;
    }
    if (liveInterval) {
      clearInterval(liveInterval);
      liveInterval = null;
    }
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus("voice-dictation", "⏳ Finalizing...");
      ctx.ui.setWidget("voice-dictation", [`⏳ Finalizing transcript (${config.model})... Esc to cancel`]);
    }

    try {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        proc.once("close", finish);
        proc.once("exit", finish);
        try {
          proc.kill("SIGINT");
        } catch {
          finish();
        }
        setTimeout(() => {
          if (!done) {
            try {
              proc.kill("SIGTERM");
            } catch {
              // Ignore
            }
            finish();
          }
        }, 800);
      });

      if (!isFinalizing) return;

      const fullPcm = Buffer.concat(pcmChunks);
      if (fullPcm.length < BYTES_PER_SEC * 0.25 || !hasDetectedSpeech) {
        if (ctx.hasUI) {
          ctx.ui.setEditorText(baseEditorText);
          ctx.ui.notify("No speech detected.", "warning");
        }
        return;
      }

      const controller = new AbortController();
      activeAbort = controller;
      const t0 = Date.now();
      const wav = buildWavFromPcm(fullPcm);
      const finalText = await callGroqWhisper(wav, config.model, controller.signal);
      const latencyMs = Date.now() - t0;

      if (!isFinalizing || controller.signal.aborted) return;

      const resolvedText = finalText || latestLiveText;
      if (ctx.hasUI) {
        ctx.ui.setEditorText(composeEditorText(baseEditorText, resolvedText));
        ctx.ui.notify(`Dictated (${latencyMs}ms)`, "info");
      }
    } catch (err) {
      if (!isFinalizing) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) {
        if (latestLiveText) {
          ctx.ui.setEditorText(composeEditorText(baseEditorText, latestLiveText));
          ctx.ui.notify(`Final pass failed (kept live text): ${msg}`, "warning");
        } else {
          ctx.ui.setEditorText(baseEditorText);
          ctx.ui.notify(`Dictation failed: ${msg}`, "error");
        }
      }
    } finally {
      activeAbort = null;
      isFinalizing = false;
      clearTimersAndHooks(ctx);
      resetState();
    }
  }

  function startRecording(ctx: ExtensionContext) {
    config = loadConfig();
    if (!config.groqApiKey) {
      if (ctx.hasUI) {
        ctx.ui.notify("Missing GROQ_API_KEY. Export it or run /voice key <gsk_...>", "error");
      }
      return;
    }

    const recorder = resolveRecorder(config.recorder);
    if (!recorder) {
      if (ctx.hasUI) {
        ctx.ui.notify("No audio recorder found. Install pipewire (pw-record), alsa-utils (arecord), or sox (rec).", "error");
      }
      return;
    }

    resetState();
    baseEditorText = ctx.hasUI ? ctx.ui.getEditorText() : "";
    projectHint = getProjectHint(ctx.cwd);
    recordingStartedAt = Date.now();
    activeCtx = ctx;

    const proc = spawn(recorder.cmd, recorder.args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderrBuf = "";
    proc.stderr?.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (recorderProc !== proc) return;
      pcmChunks.push(chunk);
      totalPcmBytes += chunk.length;
      const rms = computeRms(chunk);
      currentRms = rms;
      if (rms > 0.012) hasDetectedSpeech = true;
    });

    proc.once("error", (err) => {
      if (recorderProc === proc) {
        recorderProc = null;
        clearTimersAndHooks(ctx);
        resetState();
        if (ctx.hasUI) ctx.ui.notify(`Failed to start ${recorder.name}: ${err.message}`, "error");
      }
    });

    proc.once("close", (code) => {
      if (recorderProc === proc && code !== 0 && code !== null) {
        recorderProc = null;
        clearTimersAndHooks(ctx);
        resetState();
        if (ctx.hasUI) ctx.ui.notify(`${recorder.name} exited (${code}): ${stderrBuf.trim()}`, "error");
      }
    });

    recorderProc = proc;
    updateRecordingUI(ctx);

    uiInterval = setInterval(() => {
      meterHistory = [...meterHistory.slice(1), currentRms];
      updateRecordingUI(ctx);
    }, 120);

    liveInterval = setInterval(() => {
      void runLivePreview(ctx);
    }, Math.max(700, config.liveIntervalMs || 1400));

    if (ctx.hasUI) {
      cancelUnsubscribe = ctx.ui.onTerminalInput((data) => {
        if ((data === "\x1b" || data === "\x03") && (recorderProc || isFinalizing)) {
          cancelRecording(ctx);
          return { consume: true };
        }
        return undefined;
      });
    }
  }

  async function toggleDictation(ctx: ExtensionContext) {
    if (isFinalizing) {
      if (ctx.hasUI) ctx.ui.notify("Still finalizing transcript... (Esc to cancel)", "info");
      return;
    }
    if (recorderProc) {
      await stopAndFinalize(ctx);
    } else {
      startRecording(ctx);
    }
  }

  pi.registerShortcut(config.shortcut || "alt+v", {
    description: "Toggle live voice dictation (Groq Whisper)",
    handler: async (ctx) => {
      await toggleDictation(ctx);
    },
  });

  pi.registerCommand("voice", {
    description: "Live voice dictation: /voice | /voice key <gsk_...> | /voice model <name> | /voice lang <code|auto> | /voice status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (!sub) {
        await toggleDictation(ctx);
        return;
      }

      if (sub === "key") {
        const key = parts[1];
        if (!key) {
          ctx.ui.notify("Usage: /voice key <your_groq_api_key>", "info");
          return;
        }
        config.groqApiKey = key;
        saveConfig(config);
        ctx.ui.notify(`Saved Groq API key to ${CONFIG_PATH} (chmod 600)`, "info");
        return;
      }

      if (sub === "model") {
        const nextModel = parts[1];
        if (!nextModel) {
          ctx.ui.notify(`Final model: ${config.model} | Live preview: ${config.liveModel}`, "info");
          return;
        }
        config.model = nextModel;
        saveConfig(config);
        ctx.ui.notify(`Final voice model set to ${config.model}`, "info");
        return;
      }

      if (sub === "lang" || sub === "language") {
        const nextLang = parts[1];
        if (!nextLang) {
          ctx.ui.notify(`Current language: ${config.language || "auto"}`, "info");
          return;
        }
        config.language = nextLang === "auto" ? "" : nextLang;
        saveConfig(config);
        ctx.ui.notify(`Voice language set to ${config.language || "auto"}`, "info");
        return;
      }

      if (sub === "status") {
        const keySet = config.groqApiKey ? "configured" : "MISSING";
        const rec = resolveRecorder(config.recorder)?.name || "NONE";
        ctx.ui.notify(
          `Voice: ${config.shortcut} | rec=${rec} | live=${config.liveModel} | final=${config.model} | lang=${config.language || "auto"} | key=${keySet}`,
          "info"
        );
        return;
      }

      ctx.ui.notify("Usage: /voice | /voice key <key> | /voice model <name> | /voice lang <code|auto> | /voice status", "info");
    },
  });

  pi.on("session_shutdown", () => {
    if (recorderProc || isFinalizing) {
      cancelRecording(activeCtx);
    } else {
      clearTimersAndHooks(activeCtx);
    }
  });
}
