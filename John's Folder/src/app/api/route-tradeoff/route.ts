import { NextRequest, NextResponse } from "next/server"

/**
 * POST /api/route-tradeoff
 * Given two route summaries, returns two short tradeoff sentences for the UI.
 * Body: { routeA: { durationMinutes, distanceKm }, routeB: same, vibeA?: string, vibeB?: string }
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { tradeoffA: "Faster route.", tradeoffB: "Alternate route with different roads." },
      { status: 200 }
    )
  }
  try {
    const body = await req.json()
    const routeA = body?.routeA ?? {}
    const routeB = body?.routeB ?? {}
    const vibeA = body?.vibeA ?? "fastest"
    const vibeB = body?.vibeB ?? "alternate"

    const prompt = `You are a driving assistant. Given two route options, write exactly TWO short tradeoff sentences (one per route). Be concise. No "Route A:" prefix—just the sentence.

Route A: ${routeA.durationMinutes ?? "?"} min, ${routeA.distanceKm ?? "?"} km. Vibe: ${vibeA}.
Route B: ${routeB.durationMinutes ?? "?"} min, ${routeB.distanceKm ?? "?"} km. Vibe: ${vibeB}.

Output exactly two lines (one sentence per line):
[Sentence for Route A]
[Sentence for Route B]

Example: "Saves 4 minutes but stays on the highway."
"Adds 3 minutes but 70% is along the coast."
Under 15 words each.`

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_COPILOT_MODEL || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 80,
      }),
    })
    if (!res.ok) {
      return NextResponse.json(
        { tradeoffA: "Faster route.", tradeoffB: "Alternate route." },
        { status: 200 }
      )
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const text = data.choices?.[0]?.message?.content?.trim() ?? ""
    const lines = text.split("\n").map((s) => s.replace(/^[-*]\s*/, "").trim()).filter(Boolean)
    const tradeoffA = lines[0] ?? "Faster route."
    const tradeoffB = lines[1] ?? "Alternate route with different roads."
    return NextResponse.json({ tradeoffA, tradeoffB })
  } catch {
    return NextResponse.json(
      { tradeoffA: "Faster route.", tradeoffB: "Alternate route." },
      { status: 200 }
    )
  }
}
