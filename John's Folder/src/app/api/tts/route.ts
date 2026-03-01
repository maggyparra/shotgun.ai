import { NextRequest, NextResponse } from "next/server"

/**
 * TTS for the copilot. Priority: MiniMax > ElevenLabs > 503 (browser TTS).
 * MiniMax: set MINIMAX_API_KEY. Optionally set MINIMAX_TTS_MODEL (default: speech-2.8-turbo).
 *   Lower latency models (good for short copilot replies):
 *   - speech-02-turbo: real-time / low latency, strong for multilingual.
 *   - speech-2.6-turbo: faster, ideal for agents; speech-2.6-hd: ultra-low latency.
 *   Default / balance:
 *   - speech-2.8-turbo: best balance of quality and speed (recommended).
 *   - speech-2.8-hd: highest quality, slightly slower.
 *   Set MINIMAX_TTS_FAST_ENDPOINT=1 to use api-uw.minimax.io for reduced time-to-first-audio.
 *   Optional MINIMAX_VOICE_ID overrides the default voice.
 * ElevenLabs: optional ELEVENLABS_API_KEY if you prefer that voice.
 */
const ELEVENLABS_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM" // Rachel – clear, natural

const MINIMAX_DEFAULT_MODEL = "speech-2.8-turbo"
const MINIMAX_DEFAULT_VOICE = "English_Persuasive_Man"

async function tryElevenLabs(text: string): Promise<{ audio: ArrayBuffer; provider: "elevenlabs" } | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return null
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? ELEVENLABS_DEFAULT_VOICE
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: text.slice(0, 5000),
      model_id: "eleven_multilingual_v2",
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return null
  const audio = await res.arrayBuffer()
  return { audio, provider: "elevenlabs" }
}

async function tryMiniMax(text: string, speed = 1): Promise<{ audio: ArrayBuffer; provider: "minimax" } | null> {
  const apiKey = process.env.MINIMAX_API_KEY
  if (!apiKey) return null
  const model = process.env.MINIMAX_TTS_MODEL ?? MINIMAX_DEFAULT_MODEL
  const voiceId = process.env.MINIMAX_VOICE_ID ?? MINIMAX_DEFAULT_VOICE
  const useFastEndpoint =
    process.env.MINIMAX_TTS_FAST_ENDPOINT === "1" ||
    process.env.MINIMAX_TTS_FAST_ENDPOINT === "true"
  const baseUrl = useFastEndpoint ? "https://api-uw.minimax.io" : "https://api.minimax.io"
  const speedClamped = Math.max(0.5, Math.min(2, speed))
  const res = await fetch(`${baseUrl}/v1/t2a_v2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      text: text.slice(0, 5000),
      stream: false,
      output_format: "hex",
      voice_setting: {
        voice_id: voiceId,
        speed: speedClamped,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const err = await res.text()
    console.warn("[TTS] MiniMax failed:", res.status, err.slice(0, 300))
    return null
  }
  const data = (await res.json()) as {
    data?: { audio?: string; status?: number }
    base_resp?: { status_code?: number; status_msg?: string }
  }
  if (data.base_resp?.status_code !== 0 && data.base_resp?.status_code !== undefined) {
    console.warn("[TTS] MiniMax base_resp:", data.base_resp?.status_code, data.base_resp?.status_msg)
    return null
  }
  const hex = data.data?.audio
  if (!hex || typeof hex !== "string") {
    console.warn("[TTS] MiniMax: no audio in response. Keys:", data ? Object.keys(data) : "null")
    return null
  }
  return { audio: Buffer.from(hex, "hex").buffer as ArrayBuffer, provider: "minimax" }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const text = typeof body?.text === "string" ? body.text.trim() : ""
    if (!text) {
      return NextResponse.json({ error: "text required" }, { status: 400 })
    }
    const speed = typeof body?.speed === "number" ? body.speed : 1

    const audio =
      (await tryMiniMax(text, speed)) ?? (await tryElevenLabs(text))

    if (!audio) {
      return NextResponse.json(
        { error: "TTS not configured. Add MINIMAX_API_KEY (or ELEVENLABS_API_KEY) to .env.local for a nicer voice." },
        { status: 503 }
      )
    }

    return new NextResponse(audio.audio, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.audio.byteLength),
        "X-TTS-Provider": audio.provider,
      },
    })
  } catch (e) {
    console.error("TTS route error:", e)
    return NextResponse.json({ error: "TTS failed" }, { status: 500 })
  }
}
