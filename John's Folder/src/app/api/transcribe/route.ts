import { NextRequest, NextResponse } from "next/server"

/**
 * OpenAI Whisper: speech-to-text for the copilot.
 * Set OPENAI_API_KEY in .env.local. Accepts multipart form with "file" (audio) or JSON with "base64" audio.
 * Returns { text: string }. Optional: OPENAI_TRANSCRIBE_MODEL=whisper-1 (default), or gpt-4o-transcribe for better accuracy.
 */
const NAVIGATION_PROMPT =
  "Navigation and driving assistant. User may say addresses, street names, places, park, parking, stop, gas, navigate to, directions, route, traffic, safe, safety, carjack, avoid, add a stop, coffee, food, nearest."

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenAI API key not configured. Add OPENAI_API_KEY for Whisper transcription." },
      { status: 503 }
    )
  }

  try {
    let blob: Blob
    const contentType = req.headers.get("content-type") ?? ""

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData()
      const file = formData.get("file") as Blob | null
      if (!file || !(file instanceof Blob)) {
        return NextResponse.json({ error: "Missing or invalid file in form" }, { status: 400 })
      }
      blob = file
    } else if (contentType.includes("application/json")) {
      const body = await req.json()
      const b64 = body?.base64 ?? body?.audio
      if (typeof b64 !== "string") {
        return NextResponse.json({ error: "Missing base64 audio in body" }, { status: 400 })
      }
      const binary = Buffer.from(b64, "base64")
      blob = new Blob([binary], { type: body?.mimeType ?? "audio/webm" })
    } else {
      return NextResponse.json(
        { error: "Send multipart/form-data with 'file' or application/json with 'base64'" },
        { status: 400 }
      )
    }

    const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1"
    const form = new FormData()
    form.append("file", blob, "audio.webm")
    form.append("model", model)
    form.append("prompt", NAVIGATION_PROMPT)
    form.append("language", "en")
    if (model.startsWith("gpt-4o") && !model.includes("diarize")) {
      form.append("chunking_strategy", "auto")
    }
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const err = await res.text()
      console.warn("[transcribe] OpenAI error:", res.status, err.slice(0, 300))
      return NextResponse.json(
        { error: "Transcription failed. Try again or use tap-to-talk." },
        { status: 502 }
      )
    }

    const data = (await res.json()) as { text?: string }
    const text = (data.text ?? "").trim()
    return NextResponse.json({ text })
  } catch (e) {
    console.error("[transcribe] error:", e)
    return NextResponse.json(
      { error: "Transcription failed. Try again." },
      { status: 500 }
    )
  }
}
