import { NextResponse } from "next/server"

/**
 * GET /api/transcribe/status — tells the client whether server-side STT (OpenAI) is available.
 * When true, the voice copilot should use MediaRecorder + this API only and never fall back to browser SpeechRecognition.
 */
export async function GET() {
  const hasKey = Boolean(process.env.OPENAI_API_KEY)
  return NextResponse.json({ stt: hasKey ? "openai" : null })
}
