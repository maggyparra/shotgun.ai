import { NextRequest, NextResponse } from "next/server"
import type { CopilotContext, CopilotAction } from "@/lib/copilot-types"
import { enrichCopilotContext, formatEnrichmentForPrompt } from "@/lib/copilot-enrichment"

async function getCopilotReply(
  transcript: string,
  context: CopilotContext
): Promise<{ reply: string; action: CopilotAction }> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return {
      reply: "I can’t use the AI right now—OpenAI API key isn’t set. Add OPENAI_API_KEY to .env.local.",
      action: { type: "none" },
    }
  }

  let enrichmentLine = ""
  let areaName: string | null = null
  try {
    const enrichment = await enrichCopilotContext(context.position, context.destination)
    areaName = enrichment.areaName
    enrichmentLine = formatEnrichmentForPrompt(enrichment)
  } catch {
    // ignore
  }

  const systemPrompt = `You are a voice copilot for a driving/navigation app. The user may be driving with real GPS or simulating a route. Support both.

1) Navigation help: "Should I turn before or after the McDonald's?", "Furthest left lane or one away?" — use the current/next step and nearby POIs to give a short, clear answer.
2) Road type / frontage road: "What type of road am I on?", "Am I supposed to be on a frontage road right now?" — use the current step and next step instructions to answer. The instructions often include road names (e.g. "I-280 N" = highway, "Main St" = street, "frontage road"). Say what the instructions indicate; if they don't mention a frontage road, say so.
3) Add a stop: "Add a stop for coffee" — return add_stop with query (e.g. "coffee shop"). The app will show a list of options; the user can tap one or say "pick the first option", "the second one", "pick number 2", etc. When the user says "pick the first option", "the second option", "pick number N" (or "the first one", "the second one"), and addStopOptions is present in context, return pick_option with "index": N-1 (0-based: first=0, second=1). For time constraints (maxMinutesAdded, maxMinutesFromNow) extract when mentioned.
   - "adds at most X minutes to my journey" / "only adds X minutes" / "maximum X minutes (to my) journey" → set maxMinutesAdded to X (number).
   - "within X minutes of where I am" / "within X minutes from here" / "no more than X minutes from my current location" → set maxMinutesFromNow to X (number).
   Example: "Add a stop for gas that has diesel and only adds at maximum 5 minutes to my journey but I need it within 10 minutes of where I am right now" → ACTION: {"type":"add_stop","query":"gas station diesel","maxMinutesAdded":5,"maxMinutesFromNow":10}. Use a precise search query so the app finds the right kind of place (e.g. "gas station diesel", "coffee shop", "restaurant").
4) What's around: "What's that tower on the left?", "What is the name of the park on my right?" — nearbyPOIs include "side" (left/right) and "distance_m" (meters from user). When in simulation mode, "me" / "my location" means the simulated dot position (the app pretends that is where the user is). Always pick the CLOSEST POI on the requested side (smallest distance_m). Do NOT name a place that is far away (e.g. over 100m); if the only POI on that side is far, say you don't see something close on that side.
4b) "What is [place]?" / "Tell me about [place]" (e.g. "What is Irish Hill?", "Tell me about Base Camp"): NEVER say you don't know the place. If it appears in nearbyPOIs, describe it briefly. If not, say it's likely a local place or neighborhood and that you can get directions—then return navigate_to with the place name + city/area (e.g. "Irish Hill San Francisco") so the app can search. Do NOT refuse.
5) Lanes: "Should I be in the right lane or the left lane right now?", "Which lane?", "Am I in the correct lane?" — use currentStepText and nextStepText. Turn-by-turn instructions often include lane guidance (e.g. "Keep right", "Use the right 2 lanes to turn right", "Turn from the left lane"). Answer based on that; if the instructions don't specify lanes, say what the next maneuver is and that lane guidance isn't in the instructions.
6) Route change: "Is there a more scenic route?" — return request_alternate_route.
7) Directions / navigate to a place: "Get directions to Base Camp", "Take me to the zoo", "Map me to Starbucks" — You do NOT need to "know" the place. The app will search for it. NEVER say you don't have knowledge of the place or that you can't find it. Always return navigate_to with a search query: use the exact place name the user said and add city/area if you have it in context (e.g. "Base Camp restaurant San Francisco", "Starbucks San Francisco"). Reply with something like "Getting directions to [place]." and output ACTION: {"type":"navigate_to","query":"..."}.
8) Find places near me (discovery): "Vegetarian options near me", "Places to eat nearby", "Coffee shops near me", "Restaurants near me" — return search_nearby with a short search query (e.g. "vegetarian restaurant", "restaurant", "coffee shop"). The app will search near the user's location and show options. Only use search_nearby when the user wants to see a list of options; for "add a stop for X" always use add_stop so the app adds one directly.
9) Weather: "How's the weather on my route?", "Will it rain?" — use the Weather at your position (and Weather at destination when on a route) from context. Summarize briefly; mention both ends of the trip when you have weather at destination.
10) General conversation: The user can ask anything—random questions, chitchat, or follow-ups. Answer naturally and briefly. Only output an ACTION (add_stop, pick_option, request_alternate_route, navigate_to, search_nearby) when they clearly ask for one of those. For everything else, reply helpfully and output ACTION: {"type":"none"}.

Rules:
- Keep replies brief (1–3 sentences) for voice. No markdown.
- Put your spoken reply first (what the user hears/sees). Then on a new line output only ACTION: {"type":"..."} with no extra text. The ACTION line is stripped before the user sees or hears it—never say "ACTION" or the JSON in your reply text.
- For "navigate to [place]" or "directions to [place]": ALWAYS return navigate_to with a search query. Never refuse or say you don't know the place—the app searches and will find it.
- For "what is [place]?" / "tell me about [place]": NEVER say you don't know. Use nearby POIs if present, else offer directions and return navigate_to with place + city.
- For "X near me" / "vegetarian options" / "places to eat nearby": return search_nearby with a query so the app can show options.
- For add_stop: return add_stop with query; the app shows a list. When the user then says "pick the first option" or "the second one" (and addStopOptions is in context), return pick_option with index (0-based).
- For lane questions ("right or left lane?", "which lane?"): use currentStepText and nextStepText; instructions often include lane guidance.
- For add_stop with time constraints: When the user mentions "adds at most X minutes" or "within X minutes of where I am", include maxMinutesAdded and maxMinutesFromNow in the action. Use a precise Places search query (e.g. "gas station diesel" for gas with diesel).
- When the user asks something that doesn't match a specific action, still answer; use context (position, steps, POIs, area, weather) when relevant. In simulation mode, "me" means the simulated dot position.

Current context:
- Position: ${context.position.lat}, ${context.position.lng}
- Heading (degrees, 0=north): ${context.heading ?? "none"}
- Mode: ${context.navigationMode ?? "none (not navigating)"}
- Has active route: ${context.hasActiveRoute}
- Current step: ${context.currentStepText ?? "none"}
- Next step: ${context.nextStepText ?? "none"}
- Destination: ${context.destinationName ?? "none"}
- Nearby POIs (name, types, side left/right, distance_m from user; sorted by distance, closest first): ${context.nearbyPOIs?.length ? JSON.stringify(context.nearbyPOIs.slice(0, 15)) : "none"}
- Add-stop options (if showing; user can say "pick the first option", "the second one"): ${context.addStopOptions?.length ? context.addStopOptions.map((o, i) => `${i + 1}. ${o.name}`).join("; ") : "none"}${enrichmentLine}`

  const userMessage = `User said: "${transcript}"`

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${userMessage}\n\nWhen addStopOptions is present and the user says "pick the first option", "the second one", "pick number 2", etc., output ACTION: {"type":"pick_option","index":N} with N 0-based (first=0, second=1). For add_stop output ACTION: {"type":"add_stop","query":"..."}. For alternate route output ACTION: {"type":"request_alternate_route"}. For directions/navigate or "what is [place]?" output ACTION: {"type":"navigate_to","query":"..."}. For places "near me" list output ACTION: {"type":"search_nearby","query":"..."}. Otherwise output ACTION: {"type":"none"}.`,
        },
      ],
      max_tokens: 300,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    return {
      reply: `Sorry, the AI request failed: ${res.status}. Check your API key and quota.`,
      action: { type: "none" },
    }
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content ?? ""

  let action: CopilotAction = { type: "none" }
  const actionMatch = content.match(/ACTION:\s*(\{[\s\S]*?\})(?=\n|$)/)
  if (actionMatch) {
    try {
      const parsed = JSON.parse(actionMatch[1].trim()) as CopilotAction
      if (parsed.type === "add_stop" || parsed.type === "add_stop_place" || parsed.type === "pick_option" || parsed.type === "request_alternate_route" || parsed.type === "navigate_to" || parsed.type === "search_nearby" || parsed.type === "none") {
        action = parsed
      }
    } catch {
      /* ignore parse errors */
    }
  }

  // Fallback: user clearly asked for directions but model returned none — extract place and trigger navigate_to
  if (action.type === "none") {
    const patterns = [
      /(?:get\s+)?directions?\s+to\s+(.+)/i,
      /(?:take|map|get)\s+me\s+to\s+(.+)/i,
      /navigate\s+to\s+(.+)/i,
      /route\s+to\s+(.+)/i,
      /(?:go\s+to|drive\s+to)\s+(.+)/i,
      // "a place near me called X" — capture X first (before "what is")
      /(?:place\s+)?(?:near\s+me\s+)?called\s+([^.?!]+)/i,
      /what(?:'s| is)\s+(.+?)(?:\s+near\s+me|\s*$)/i,
      /tell\s+me\s+about\s+(.+)/i,
      /where\s+is\s+(.+)/i,
    ]
    for (const p of patterns) {
      const m = transcript.trim().match(p)
      if (m && m[1]) {
        let query = m[1].trim()
        if (query.length > 2) {
          if (areaName && !/\b(san\s+francisco|oakland|berkeley|sf|california|ca)\b/i.test(query)) {
            query = `${query} ${areaName}`
          }
          action = { type: "navigate_to", query }
          break
        }
      }
    }
  }

  // Fallback: "X near me" / "vegetarian options near me" etc. — search_nearby
  if (action.type === "none") {
    const nearMeMatch = transcript.trim().match(/(.+?)\s+near\s+me\s*$/i)
    if (nearMeMatch && nearMeMatch[1]) {
      const q = nearMeMatch[1].trim().toLowerCase()
      // Avoid matching "take me to X" (already handled above). Prefer category-like queries.
      if (q.length > 2 && !/^(?:take|get|map|navigate|route|go|drive)\s+me\s+to\s+/i.test(transcript.trim())) {
        const categoryQuery = q.replace(/\s+(?:to\s+)?(?:eat|get|find)\s*$/i, "").trim() || q
        if (categoryQuery.length > 1) {
          action = { type: "search_nearby", query: categoryQuery }
        }
      }
    }
  }

  // Fallback: "pick the first option", "the second one", "pick number 2" when addStopOptions is showing
  if (action.type === "none" && context.addStopOptions?.length) {
    const t = transcript.trim().toLowerCase()
    const ordinals: [RegExp, number][] = [
      [/pick\s+(?:the\s+)?(?:first|1st|number\s*1|#1)\s*(?:option|one)?/i, 0],
      [/the\s+first\s*(?:option|one)/i, 0],
      [/pick\s+(?:the\s+)?(?:second|2nd|number\s*2|#2)\s*(?:option|one)?/i, 1],
      [/the\s+second\s*(?:option|one)/i, 1],
      [/pick\s+(?:the\s+)?(?:third|3rd|number\s*3|#3)\s*(?:option|one)?/i, 2],
      [/the\s+third\s*(?:option|one)/i, 2],
      [/\b(?:fourth|4th|number\s*4|#4)\b/, 3],
      [/\b(?:fifth|5th|number\s*5|#5)\b/, 4],
    ]
    for (const [p, i] of ordinals) {
      if (p.test(t) && i < context.addStopOptions!.length) {
        action = { type: "pick_option", index: i }
        break
      }
    }
  }

  // Strip ACTION: {...} from reply so it never appears in the bubble or TTS (match from last "ACTION:" when followed by JSON)
  let reply = content
  const actionLabel = "ACTION:"
  const idx = reply.toUpperCase().lastIndexOf(actionLabel)
  if (idx >= 0) {
    const after = reply.slice(idx)
    if (/^ACTION:\s*\{/.test(after)) {
      reply = reply.slice(0, idx).trim()
    }
  }
  reply = reply
    .replace(/\n\s*ACTION:[\s\S]*$/i, "")
    .trim()
    .slice(0, 400)

  // If we forced navigate_to from fallback, replace unhelpful reply (e.g. "I don't know that place") with a short confirmation
  if (action.type === "navigate_to" && action.query && /don't have knowledge|can't find|don't know|unable to find|not (?:in my |in the )?(?:knowledge|database)/i.test(reply)) {
    return { reply: `Getting directions to ${action.query}.`, action }
  }

  return { reply: reply || "Got it.", action }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { transcript, context } = body as { transcript: string; context: CopilotContext }
    if (!transcript || typeof transcript !== "string") {
      return NextResponse.json({ error: "transcript required" }, { status: 400 })
    }
    const result = await getCopilotReply(transcript.trim(), context ?? {
      position: { lat: 0, lng: 0 },
      hasActiveRoute: false,
    })
    return NextResponse.json(result)
  } catch (e) {
    console.error("Copilot API error:", e)
    return NextResponse.json(
      { reply: "Something went wrong. Try again.", action: { type: "none" } },
      { status: 500 }
    )
  }
}
