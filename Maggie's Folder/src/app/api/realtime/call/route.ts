import { NextResponse } from "next/server"

const SESSION_CONFIG = {
  type: "realtime",
  model: "gpt-4o-realtime-preview-2024-12-17",
  audio: { output: { voice: "alloy" } },
  tools: [
    {
      type: "function",
      name: "propose_stop",
      description:
        "Call this when the user says 'Add a stop to [Place]' or similar. Use for adding a waypoint to the current route.",
      parameters: {
        type: "object",
        properties: {
          location_name: { type: "string", description: "The place type or name, e.g. Starbucks, gas station" },
          similar_category: { type: "string", description: "Optional similar category hint" },
        },
        required: ["location_name"],
      },
    },
    {
      type: "function",
      name: "confirm_add_stop",
      description:
        "Call when the user clearly says YES or confirms they want to add the proposed stop. Only call if you previously proposed a stop and asked for confirmation.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "cancel_proposal",
      description:
        "Call when the user says NO or declines the proposed stop. Say 'Understood, WE are sticking to the original route' and clear the proposal.",
      parameters: { type: "object", properties: {} },
    },
  ],
  tool_choice: "auto",
}

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 })
  const sdp = await req.text()
  const fd = new FormData()
  fd.set("sdp", sdp)
  fd.set("session", JSON.stringify(SESSION_CONFIG))
  const res = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  })
  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: err }, { status: res.status })
  }
  const answerSdp = await res.text()
  return new NextResponse(answerSdp, {
    headers: { "Content-Type": "application/sdp" },
  })
}
