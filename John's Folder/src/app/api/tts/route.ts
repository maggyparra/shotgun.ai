import { NextRequest, NextResponse } from "next/server"

/**
 * MiniMax T2A: human-like TTS for the copilot.
 * Set MINIMAX_API_KEY in .env.local. If unset, returns 503 so frontend falls back to browser TTS.
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.MINIMAX_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: "MiniMax TTS not configured" }, { status: 503 })
  }

  try {
    const body = await req.json()
    const text = typeof body?.text === "string" ? body.text.trim() : ""
    if (!text) {
      return NextResponse.json({ error: "text required" }, { status: 400 })
    }

    const res = await fetch("https://api.minimax.io/v1/t2a_v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "speech-2.8-turbo",
        text: text.slice(0, 5000),
        stream: false,
        output_format: "hex",
        voice_setting: {
          voice_id: "English_Persuasive_Man",
          speed: 1,
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
    })

    if (!res.ok) {
      const err = await res.text()
      console.error("MiniMax TTS error:", res.status, err)
      return NextResponse.json({ error: "TTS failed" }, { status: 502 })
    }

    const data = (await res.json()) as {
      data?: { base_resp?: { audio?: string }; extra_info?: { audio_format?: string } }
    }
    const hex = data?.data?.base_resp?.audio
    if (!hex || typeof hex !== "string") {
      return NextResponse.json({ error: "No audio in response" }, { status: 502 })
    }

    const buf = Buffer.from(hex, "hex")
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(buf.length),
      },
    })
  } catch (e) {
    console.error("TTS route error:", e)
    return NextResponse.json({ error: "TTS failed" }, { status: 500 })
  }
}
