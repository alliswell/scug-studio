"use node";
// Writes out voice notes with word timings. Uses whichever speech-to-text key is set on the Convex
// deployment: ELEVENLABS_API_KEY (Scribe v2, the most accurate), DEEPGRAM_API_KEY or OPENAI_API_KEY, in that order.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

type Word = { w: string; s: number; e: number };
const round = (n: number) => Math.round(n * 100) / 100;

async function deepgram(key: string, url: string): Promise<Word[]> {
  const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const words = data?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  return words.map((x: { word: string; punctuated_word?: string; start: number; end: number }) => ({ w: x.punctuated_word ?? x.word, s: round(x.start), e: round(x.end) }));
}

async function elevenlabs(key: string, url: string, model = "scribe_v2"): Promise<Word[]> {
  const form = new FormData();
  form.append("model_id", model);
  form.append("cloud_storage_url", url);
  form.append("timestamps_granularity", "word");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    // Fall back to the previous Scribe model if this account doesn't have v2
    if (model === "scribe_v2" && res.status >= 400 && res.status < 500 && /model/i.test(body)) return elevenlabs(key, url, "scribe_v1");
    throw new Error(`ElevenLabs ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data?.words ?? [])
    .filter((x: { type?: string }) => x.type === "word" || x.type === undefined)
    .map((x: { text: string; start: number; end: number }) => ({ w: x.text.trim(), s: round(x.start), e: round(x.end) }))
    .filter((x: Word) => x.w);
}

async function openai(key: string, url: string, mime: string | undefined): Promise<Word[]> {
  const file = await fetch(url);
  if (!file.ok) throw new Error(`Couldn't download the recording (${file.status})`);
  const blob = await file.blob();
  if (blob.size > 25 * 1024 * 1024) throw new Error("OpenAI only transcribes files up to 25 MB");
  const type = mime ?? blob.type ?? "audio/webm";
  const form = new FormData();
  // Whisper picks its decoder from the filename, so the extension has to match the type
  form.append("file", new Blob([await blob.arrayBuffer()], { type }), `recording.${type.split("/")[1]?.split(";")[0] || "webm"}`);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data?.words ?? []).map((x: { word: string; start: number; end: number }) => ({ w: x.word.trim(), s: round(x.start), e: round(x.end) }));
}

/** A voice note on a PDF, written out (when a speech-to-text key is set up; otherwise it stays a recording) */
export const pdfVoiceNote = internalAction({
  args: { noteId: v.id("pdfNotes") },
  handler: async (ctx, { noteId }): Promise<null> => {
    const info = await ctx.runQuery(internal.pdfs.voiceNoteFile, { noteId });
    if (!info?.url) return null;
    const keys = { deepgram: process.env.DEEPGRAM_API_KEY, elevenlabs: process.env.ELEVENLABS_API_KEY, openai: process.env.OPENAI_API_KEY };
    try {
      const words = keys.elevenlabs
        ? await elevenlabs(keys.elevenlabs, info.url)
        : keys.deepgram
          ? await deepgram(keys.deepgram, info.url)
          : keys.openai
            ? await openai(keys.openai, info.url, info.mime ?? "audio/webm")
            : null;
      if (words?.length) await ctx.runMutation(internal.pdfs.saveTranscript, { noteId, transcript: words.map((w) => w.w).join(" ").replace(/\s+([.,!?;:])/g, "$1") });
    } catch {
      // The recording is still there to play
    }
    return null;
  },
});
