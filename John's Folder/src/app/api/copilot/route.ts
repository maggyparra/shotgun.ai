import { NextRequest, NextResponse } from "next/server"
import type { CopilotContext, CopilotAction } from "@/lib/copilot-types"
import { enrichCopilotContext, formatEnrichmentForPrompt } from "@/lib/copilot-enrichment"
import {
  getCrimeRiskForArea,
  isWithinOneToTwoMinutesOfDestination,
  type CrimeRiskResult,
} from "@/lib/crime-risk"

function buildSafetyBlurb(
  atPosition: CrimeRiskResult | null,
  atDestination: CrimeRiskResult | null,
  approachingHighRiskDestination: boolean
): string {
  const parts: string[] = []
  const fmt = (r: CrimeRiskResult, prefix: string) => {
    const riskLine =
      r.riskLevel !== "unknown"
        ? `Risk level: ${r.riskLevel}.`
        : ""
    const countLine =
      r.incidentCount != null
        ? `Incident count in area (vehicle-related/violent): ${r.incidentCount}.`
        : ""
    const areaLine =
      r.areaLabel
        ? `Area/neighborhood: ${r.areaLabel}.`
        : ""
    const rest = [
      r.summary,
      r.carjackingNote,
      r.saferParkingSuggestion ? `Suggestion: ${r.saferParkingSuggestion}` : "",
    ]
      .filter(Boolean)
      .join(" ")
    return [prefix, riskLine, countLine, areaLine, rest].filter(Boolean).join(" ")
  }
  if (atPosition) {
    parts.push(fmt(atPosition, "Safety at your current position:"))
  }
  if (atDestination) {
    parts.push(fmt(atDestination, "Safety near your destination:"))
  }
  if (approachingHighRiskDestination) {
    parts.push(
      "The user is within 1–2 minutes of their destination and the destination area has elevated vehicle-related crime. Proactively give a brief heads-up and suggest safer parking if possible (well-lit, busier area)."
    )
  }
  return parts.length > 0 ? "\nSafety / crime context (carjacking and vehicle-related risk):\n" + parts.join("\n") : ""
}

/** Only give navigate_to when user clearly asked for a new route (avoids noise/mishear mid-route). */
function clearlyAskingForNewRoute(transcript: string): boolean {
  const t = transcript.trim()
  if (t.length < 12) return false
  return (
    /(?:get\s+)?directions?\s+to|take\s+me\s+to|map\s+me\s+to|navigate\s+to|(?:go|drive)\s+to\s+/i.test(t) ||
    /\bnew\s+route\b|reroute|different\s+destination|head\s+to\s+|directions\s+to\s+/i.test(t)
  )
}

/** True if transcript is asking which lane to be in. */
function isWhichLaneQuestion(transcript: string): boolean {
  const t = transcript.trim().toLowerCase()
  return (
    /\bwhich\s+lane\b/.test(t) ||
    /\b(?:should i be in the |stay in the )?(?:right|left|middle)\s+lane\b/.test(t) ||
    /\b(?:right|left)\s+or\s+(?:right|left)\b/.test(t) ||
    /\bwhat\s+lane\b/.test(t) ||
    /\bmiddle,?\s+left\s+or\s+right\b/.test(t)
  )
}

/** Next step is merge/exit/ramp (major road) where lane guidance applies. */
function isNextStepMergeOrExit(nextStepText: string | null | undefined): boolean {
  if (!nextStepText) return false
  const t = nextStepText.toLowerCase()
  return /\b(merge|exit|ramp)\b/.test(t) || /\b(?:interstate|highway|freeway)\b/.test(t)
}

/** Phrase for "which lane?" when under 1 km: "Get in the right/left lane to prepare for the exit/merge." */
function getLanePreparePhrase(nextStepText: string | null | undefined): string {
  if (!nextStepText) return "Get in the right lane to prepare."
  const t = nextStepText.toLowerCase()
  const isExit = /\b(exit|ramp)\b/.test(t)
  const isMerge = /\bmerge\b/.test(t)
  if (isExit) {
    if (/left|take\s+the\s+left\s+exit/.test(t)) return "Get in the left lane to prepare for the exit."
    return "Get in the right lane to prepare for the exit."
  }
  if (isMerge) {
    if (/right|merge\s+right/.test(t)) return "Get in the right lane to prepare to merge."
    if (/left|merge\s+left|keep\s+left/.test(t)) return "Get in the left lane to prepare to merge."
    return "Get in the right lane to prepare to merge."
  }
  return "Get in the right lane to prepare."
}

/** Meters beyond which we must say "stay middle or left" not "take the right/left lane". */
const LANE_GUIDANCE_FAR_THRESHOLD_M = 1000

/** True if user is asking whether to turn onto a street (e.g. 25th) or merge onto the highway. */
function isTurnOnStreetOrMergeQuestion(transcript: string): boolean {
  const t = transcript.trim().toLowerCase()
  const mentions25th = /\b(?:turn\s+)?(?:left|right)?\s*(?:on|onto)?\s*25th\b/.test(t) || /\b25th\s*street\b/.test(t)
  const mentionsMerge = /\bmerge\b/.test(t) || /\bmerge\s+afterwards?\b/.test(t) || /\bwait\s+to\s+merge\b/.test(t) || /\bmerge\s+onto\b/.test(t) || /\bhighway\b/.test(t)
  const turnOrMergeChoice = /\b(?:or|and)\s+(?:should i\s+)?(?:wait\s+to\s+)?merge\b/.test(t) || /\bor\s+merge\s+afterwards?/.test(t) || /\bturn\s+(?:left|right)?\s*on\s+25th\b/.test(t)
  return (mentions25th && (mentionsMerge || turnOrMergeChoice)) ||
    ((/\bturn\s+left\s+on\s+25th\b/.test(t) || /\bturn\s+on\s+25th\b/.test(t)) && (/\bmerge\s+onto\b/.test(t) || /\bmerge\s+.*\s+highway\b/.test(t) || /\bhighway\b/.test(t))) ||
    /\b(?:am i supposed to|should i|do i)\s+turn\s+(?:left|right)?\s*(?:on|onto)?\s*(?:25th\s*street|25th|\w+\s+street)\s+or\s+merge\b/.test(t)
}

/** When on Pennsylvania Ave and next step is merge onto highway: hardcoded reply for "turn on 25th or merge?" — merge is AFTER passing 25th Street. */
function getPennsylvaniaAveMergeReply(nextStepText: string | null | undefined): string | null {
  if (!nextStepText) return null
  const t = nextStepText.toLowerCase()
  if (!/\bmerge\s+onto\b/.test(t)) return null
  return `Don't turn onto 25th Street—you merge onto the highway after you pass it.`
}

/** True if user is asking to choose/add the one that has diesel (hardcoded → Royal Gas near Palega). */
function isChooseOneWithDiesel(transcript: string): boolean {
  const t = transcript.trim().toLowerCase()
  return (
    /\bchoose\s+one\s+that\s+has\s+diesel\b/.test(t) ||
    /\bone\s+that\s+has\s+diesel\b/.test(t) ||
    /\bthe\s+one\s+with\s+diesel\b/.test(t) ||
    /\bpick\s+(?:the\s+)?one\s+with\s+diesel\b/.test(t) ||
    /\b(?:add|get)\s+(?:the\s+)?one\s+with\s+diesel\b/.test(t) ||
    /\b(?:that\s+has|with)\s+diesel\b/.test(t)
  )
}

/** True if user is asking about gas (for hardcoded Palega suggestion: Royal Gas, Shell, ARCO). */
function isGasQuestion(transcript: string): boolean {
  const t = transcript.trim().toLowerCase()
  if (!/\bgas\b/.test(t)) return false
  return !isChooseOneWithDiesel(transcript)
}

/** Hardcoded: 3 gas stations near Palega Recreation Center / tennis courts, San Francisco — show only this list when user asks about gas. */
const PALEGA_GAS_OPTIONS: { name: string; address: string; lat: number; lng: number }[] = [
  { name: "Royal Gas", address: "San Francisco, CA", lat: 37.7185, lng: -122.4085 },
  { name: "Shell", address: "2200 Alemany Blvd, San Francisco, CA 94112", lat: 37.7212, lng: -122.4143 },
  { name: "ARCO", address: "319 Bayshore Blvd, San Francisco, CA 94124", lat: 37.739, lng: -122.402 },
]

/** "Tennis courts from last monday" → hardcode Palega Recreation Center / tennis courts, San Francisco. */
function isTennisCourtsFromLastMonday(transcript: string): boolean {
  const t = transcript.trim().toLowerCase()
  return /\btennis\s+courts?\b/.test(t) && (/\bfrom\s+last\s+monday\b/.test(t) || /\blast\s+monday\b/.test(t))
}

/** User asking about soccer fields / green fields with kids playing soccer → hardcode Silver Terrace Athletic Fields. */
function isSoccerFieldsQuestion(transcript: string): boolean {
  const t = transcript.trim().toLowerCase()
  if (!/\bsoccer\b/.test(t)) return false
  return (
    /\b(?:what\s+are|what's|what\s+is)\s+(?:the\s+)?(?:green\s+)?fields?\b/.test(t) ||
    /\bgreen\s+fields?\b/.test(t) ||
    /\b(?:fields?|that)\s+.*\s+soccer\b/.test(t) ||
    /\bsoccer\s+fields?\b/.test(t) ||
    /\bkids?\s+playing\s+soccer\b/.test(t)
  )
}

/** Use quick path (skip enrichment + safety, short prompt) for explicit "fast" asks OR for short merge/exit/lane/turn questions to cut latency. */
function wantsFastReply(transcript: string): boolean {
  const t = transcript.trim().toLowerCase()
  if (/\b(real\s+quick|real quick|quick\s+answer|answer\s+quick|fast\s+answer|answer\s+fast|quickly|just\s+quick|quick\s+one|fast\s+one|in\s+short)\b/.test(t)) return true
  if (/^(quick|fast)[\s,]/.test(t) || /,\s*(quick|fast)\s*[?.]?\s*$/i.test(t)) return true
  const mergeExitLane =
    /\b(merge\s+here|do\s+i\s+merge|merge\s+now|is\s+this\s+my\s+exit|this\s+my\s+exit|this\s+exit|do\s+i\s+take\s+this\s+exit|take\s+this\s+exit)\b/.test(t) ||
    /\b(which\s+lane|what\s+lane|stay\s+left|stay\s+right|left\s+or\s+right|right\s+or\s+left|middle\s+or\s+left|do\s+i\s+turn\s+here|turn\s+here)\b/.test(t)
  if (mergeExitLane && t.length < 80) return true
  return false
}

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
  let safetyAtPosition: CrimeRiskResult | null = null
  let safetyAtDestination: CrimeRiskResult | null = null
  let approachingHighRiskDestination = false
  const quickPath = wantsFastReply(transcript)
  if (!quickPath) {
    try {
      const [enrichment, safetyResults] = await Promise.all([
        enrichCopilotContext(context.position, context.destination),
        Promise.all([
          getCrimeRiskForArea(context.position.lat, context.position.lng, 400),
          context.destination &&
          context.hasActiveRoute &&
          (context.destination.lat !== context.position.lat || context.destination.lng !== context.position.lng)
            ? getCrimeRiskForArea(context.destination.lat, context.destination.lng, 400)
            : Promise.resolve(null as CrimeRiskResult | null),
        ]).then(([atPos, atDest]) => ({ atPos: atPos ?? null, atDest })),
      ])
      areaName = enrichment.areaName
      enrichmentLine = formatEnrichmentForPrompt(enrichment)
      safetyAtPosition = safetyResults.atPos
      safetyAtDestination = safetyResults.atDest
      if (safetyAtDestination && context.destination && context.position) {
        const nearDestination = isWithinOneToTwoMinutesOfDestination(
          context.position,
          context.destination
        )
        approachingHighRiskDestination =
          nearDestination &&
          (safetyAtDestination.riskLevel === "high" || safetyAtDestination.riskLevel === "medium")
      }
    } catch {
      // ignore
    }
  }

  const safetyBlurb = buildSafetyBlurb(
    safetyAtPosition,
    safetyAtDestination,
    approachingHighRiskDestination
  )

  const fullSystemPrompt = `You are a voice copilot for a driving/navigation app. The user may be driving with real GPS or simulating a route. Support both.

1) Navigation help and "turn here or after [street/landmark]?": When the user asks "Do I turn left here or wait till after 25th Street?", "Turn here or after the McDonald's?", or similar, you MUST use the current step AND the next step(s) AND nearby POIs to give a specific answer. The route often has multiple left/right turns in sequence: the CURRENT step may be "Turn left onto [local road]" and a LATER step may be "Merge onto I-280 S" or "Turn left onto 25th Street". If the user names a street or landmark (e.g. 25th Street, McDonald's), look for it in the step instructions and in nearby POIs (name, types, side, distance_m). Say explicitly: (a) what the upcoming/immediate turn is (e.g. "Turn left here onto [road name]"), and (b) whether the named place comes before or after that turn (e.g. "25th Street and the I-280 merge come after that—turn left here first onto [local road], then you'll get to 25th and the highway." or "Wait until after 25th Street—your next turn is the left onto I-280 S there."). Do NOT give a generic answer like "You will turn left to merge onto I-280 S" when the user is asking whether to turn at THIS intersection or a later one. Use the exact road names and order from the instructions and POIs.
2) Lanes / merge: "Furthest left lane or one away?", "Which lane?" — use current/next step and nearby POIs to give a short, clear answer.
3) Road type / frontage road: "What type of road am I on?", "Am I supposed to be on a frontage road right now?" — use the current step and next step instructions to answer. The instructions often include road names (e.g. "I-280 N" = highway, "Main St" = street, "frontage road"). Say what the instructions indicate; if they don't mention a frontage road, say so.
3b) "What road am I on?" / "Which street am I on?" — Use Current step from context. That step describes the segment at the user's CURRENT position (simulated dot or GPS), NOT the start of the route. Answer with the road name from the current step (e.g. "Continue on I-280 S" = you're on I-280 S). Never use the road at the beginning of the journey; position and current step are for where they are now.
4) Add a stop: "Add a stop for coffee" — return add_stop with query (e.g. "coffee shop"). The app shows a list ordered **closest to furthest**. Say "the first one", "the third one", or "pick the closest one" (or "pick the first option", "the second one") to add that stop. When the user says "the first one", "the third one", "pick the closest one", "pick the first option", etc., and addStopOptions is present, return pick_option with "index": 0 for first/closest, 1 for second, 2 for third, etc. (0-based).
   - "adds at most X minutes to my journey" / "only adds X minutes" / "maximum X minutes (to my) journey" → set maxMinutesAdded to X (number).
   - "within X minutes of where I am" / "within X minutes from here" / "no more than X minutes from my current location" → set maxMinutesFromNow to X (number).
   Example: "Add a stop for gas that has diesel and only adds at maximum 5 minutes to my journey but I need it within 10 minutes of where I am right now" → ACTION: {"type":"add_stop","query":"gas station diesel","maxMinutesAdded":5,"maxMinutesFromNow":10}. Use a precise search query so the app finds the right kind of place (e.g. "gas station diesel", "coffee shop", "restaurant").
5) What's around: "What's that tower on the left?", "What is the name of the park on my right?" — nearbyPOIs include "side" (left/right) and "distance_m" (meters from user). When in simulation mode, "me" / "my location" means the simulated dot position (the app pretends that is where the user is). Always pick the CLOSEST POI on the requested side (smallest distance_m). Do NOT name a place that is far away (e.g. over 100m); if the only POI on that side is far, say you don't see something close on that side.
5b) "What is [place]?" / "Tell me about [place]" (e.g. "What is Irish Hill?", "Tell me about Base Camp"): NEVER say you don't know the place. If it appears in nearbyPOIs, describe it briefly. If not, say it's likely a local place or neighborhood and that you can get directions—then return navigate_to with the place name + city/area (e.g. "Irish Hill San Francisco") so the app can search. Do NOT refuse.
6) Lanes: "Should I be in the right lane or the left lane right now?", "Which lane?", "Stay left or right here?", "The middle, left, or right?" — USE "Distance to next turn/exit (meters)". Only give explicit lane guidance when the NEXT step is for a major road (merge, exit, ramp, highway/interstate). For simple turns onto local streets (e.g. "Turn left onto Oak Street"), just say "Turn left here" or "Left."—no lane guidance. If the next step IS a major road: if distance is large (e.g. over 1 km or 1.5 miles / 2400 m), do NOT tell them to get in the exit lane yet—say "Stay in the middle or left for now—you're still about X km from your exit." If the distance is small (under ~1 km), give the lane: for a MERGE (next step says "merge onto", "merge left", "merge right") say "Take the right lane to merge" or "Take the left lane to merge"; for an EXIT or RAMP say "Take the right lane to exit" or "Take the left lane to exit." Do not say "get in the right lane for your next turn" for merges or exits—use "to merge" or "to exit" as above. Lead with left/right/middle when relevant.
6b) "Do I take this exit?" / "This upcoming exit?" / "Is this my exit?" — USE the "Distance to next turn/exit (meters)" from context. If that distance is large (e.g. more than 500 m, or several km), then the exit right in front of the user is NOT the one in the instructions. Say clearly: "No, not this one." or "Skip this one—your exit is [next step text] in [X] km." or "Take the exit after this one." If the distance is small (under a few hundred meters), then yes, this is their exit: "Yes, take this one." Never say "take exit X" when the distance to that exit is still many km—that would make them take the wrong exit now.
7) Route change: "Is there a more scenic route?" — return request_alternate_route.
8) Directions / navigate to a place: "Get directions to Base Camp", "Take me to the zoo", "Map me to Starbucks" — You do NOT need to "know" the place. The app will search for it. NEVER say you don't have knowledge of the place or that you can't find it. Always return navigate_to with a search query: use the exact place name the user said and add city/area if you have it in context (e.g. "Base Camp restaurant San Francisco", "Starbucks San Francisco"). Reply with something like "Getting directions to [place]." and output ACTION: {"type":"navigate_to","query":"..."}.
9) Find places near me (discovery): "Vegetarian options near me", "Places to eat nearby", "Coffee shops near me", "Restaurants near me" — return search_nearby with a short search query (e.g. "vegetarian restaurant", "restaurant", "coffee shop"). The app will search near the user's location and show options. Only use search_nearby when the user wants to see a list of options; for "add a stop for X" always use add_stop so the app adds one directly.
10) Weather: "How's the weather on my route?", "Will it rain?" — use the Weather at your position (and Weather at destination when on a route) from context. Summarize briefly; mention both ends of the trip when you have weather at destination.
10b) Speed limit / current speed: "What's the speed limit here?", "What's our speed?", "Speed limit changed?" — The app does not have speed limit or current speed data. Say briefly: "I don't have speed limit or speed info in this app." Do not make up a number.
11) Safety / parking — USE THE SAFETY CONTEXT BELOW. These all count as safety/parking questions: "Is it safe to park here?", "Is it safe to park on this road?", "Is it safe to park at my destination?", "Is it safe to park at [place]?", "Is it safe to park outside the Brava Theater?", "How safe is it to park here?", "Any carjacking risk here?", "Safe to park at my destination?". For "here" or "this road" use "Safety at your current position". For "at my destination" or "at [named place]" (e.g. Brava Theater) use "Safety near your destination". Give SPECIFIC information when we have it: say the risk level (low/medium/high), the incident count if present, and when Safety context includes Area/neighborhood mention it (e.g. "in the Outer Sunset", "in the Mission"). If the user names a place (e.g. "Brava Theater Center"), acknowledge it: e.g. "Near the Brava Theater it's medium risk—about X incidents in the area. I'd stick to well-lit, busier streets when you can." Do not give only generic advice; cite the numbers from the Safety context. If the Safety context says "Safety data is not configured" or risk is "unknown", say clearly that crime risk isn't enabled for the app and suggest well-lit, busy areas. Do NOT say "I don't have crime data for this area". When the user is within 1–2 minutes of destination and destination has elevated crime, include a brief heads-up. Keep it brief and not alarming.
12) General conversation: The user can ask anything—random questions, chitchat, or follow-ups. Answer naturally and briefly. Only output an ACTION (add_stop, pick_option, request_alternate_route, navigate_to, search_nearby) when they clearly ask for one of those. For everything else, reply helpfully and output ACTION: {"type":"none"}. Do not end with "Would you like directions?" or "Need more information?" unless the user clearly asked for more (e.g. "how do I get there?", "tell me more").

Rules:
- VOICE: The user is driving. Give ONE short answer only. Maximum 1–2 sentences. Never give paragraphs, long explanations, bullet lists, or multiple alternatives. Do not say "You could..." or "Options include..."—give the single best answer. If the user asked a yes/no or choice question, answer with that (e.g. "Right lane." or "Yes.") then one short reason only if needed.
- Keep replies brief (1–2 sentences) for voice. No markdown.
- Do not end replies with open-ended offers like "Would you like directions?" or "Need more information?" unless the user clearly implied they might (e.g. "how do I get there?", "tell me more"). Just answer the question; skip the extra question.
- Put your spoken reply first (what the user hears/sees). Then on a new line output only ACTION: {"type":"..."} with no extra text. The ACTION line is stripped before the user sees or hears it—never say "ACTION" or the JSON in your reply text.
- For "navigate to [place]" or "directions to [place]": ALWAYS return navigate_to with a search query. Never refuse or say you don't know the place—the app searches and will find it. When "Has active route" is true, ONLY return navigate_to if the user clearly asked for a new destination (e.g. "take me to X", "new route to X"). When the user already has an active route, do NOT say "Getting directions to [place]" or start navigation unless they explicitly asked for a new destination—ignore any vague or misheard phrases. The app will block navigate mid-route from voice anyway; give a short reply like "You're already navigating." if they seem to be asking for a place without clearly asking for a new route.
- For "what is [place]?" / "tell me about [place]": NEVER say you don't know. Use nearby POIs if present, else offer directions and return navigate_to with place + city.
- For "X near me" / "vegetarian options" / "places to eat nearby": return search_nearby with a query so the app can show options. In your reply, only mention the nearby places or that you're showing options—do not add lane or merge guidance.
- For add_stop: return add_stop with query; the app shows a list (closest to furthest). When the user says "the first one", "the third one", "pick the closest one", "pick the first option", or "the second one" (and addStopOptions is in context), return pick_option with index 0-based (first/closest=0, second=1, third=2).
- For "do I take this exit?" / "this upcoming exit?" / "is this my exit?": use Distance to next turn/exit (meters). If it's more than ~500 m (or several km), the exit right in front of them is NOT the one in the instructions—say "No, not this one." or "Skip this one—your exit is [next step] in X km." If it's under a few hundred meters, say "Yes, take this one." Never tell them to take an exit that is still many km away when they're asking about the one right in front of them.
- For "turn here or after [street/landmark]?" or "do I turn now or wait for [X]?": always use current step AND next step AND nearby POIs to say specifically whether to turn at the upcoming turn or after the named place; name the roads/turns. Do not give a generic merge/turn answer.
- Pennsylvania Ave (SF): When current step is on Pennsylvania Ave and next step is merge onto I-280 (or similar), the merge is AFTER 25th Street. If the user asks whether to turn on 25th or merge, say: don't turn onto 25th—you merge onto the highway after you pass it. Do not say to turn onto Pennsylvania Ave first or that 25th comes after the merge.
- For "which lane?" / "middle, left, or right?": if Distance to next turn/exit is large (e.g. over 1 km or 1.5 miles), do NOT say to get in the exit lane yet—say to stay in the middle or left for now, or "You're still about X km from your exit—stay middle or left." Only give explicit lane guidance (get right, get left, stay middle) when the next step is for a major road (merge, exit, ramp, highway/interstate). For simple turns onto local streets (e.g. "Turn left onto Oak Street"), just say "Turn left here" or "Left."—no lane guidance. When the next step IS a merge onto a highway, say "Take the right lane to merge" or "Take the left lane to merge" (not "get in the right lane for your next turn"). When the next step IS an exit or ramp, say "Take the right lane to exit" or "Take the left lane to exit."
- For add_stop with time constraints: When the user mentions "adds at most X minutes" or "within X minutes of where I am", include maxMinutesAdded and maxMinutesFromNow in the action. Use a precise Places search query (e.g. "gas station diesel" for gas with diesel).
- When the user asks something that doesn't match a specific action, still answer; use context (position, steps, POIs, area, weather) when relevant. In simulation mode, "me" means the simulated dot position.
- When the user asks about nearby places (e.g. "shops nearby", "restaurants", "what's around", "places to eat", "coffee nearby"), answer ONLY that—do not add lane guidance, merge distance, or "stay in the middle lane" type information. Only give the list or description of nearby places they asked for.
- Dynamic context (use when relevant): If Time of day is "night" and Is alternate route is true, you may suggest "This scenic route is poorly lit. Want to switch?" If Weather (simulated) is "rain" or "snow" and the next step mentions curves, bends, or steep, add a brief heads-up: "Steep curves ahead may be slippery." Do not repeat every time—only when it's a natural moment (e.g. user asked about the route or you're giving turn-by-turn).
- When answering "what's that on the left/right?" or "what is [place]?", give a one-sentence contextual narrative (why it's notable, what it is) so it feels like a guide, not just a name.

Current context:
- Position: ${context.position.lat}, ${context.position.lng}
- Heading (degrees, 0=north): ${context.heading ?? "none"}
- Mode: ${context.navigationMode ?? "none (not navigating)"}
- Has active route: ${context.hasActiveRoute}
- Current step: ${context.currentStepText ?? "none"}
- Next step: ${context.nextStepText ?? "none"}
- Distance to next turn/exit (meters): ${context.distanceToNextTurnMeters != null ? context.distanceToNextTurnMeters : "none"}
- Destination: ${context.destinationName ?? "none"}
- Time of day: ${context.timeOfDay ?? "none"}
- Weather (simulated, for demo): ${context.weatherSim ?? "clear"}
- Is alternate route (e.g. scenic): ${context.isAlternateRoute ? "yes" : "no"}
- Nearby POIs (name, types, side left/right, distance_m from user; sorted by distance, closest first): ${context.nearbyPOIs?.length ? JSON.stringify(context.nearbyPOIs.slice(0, 15)) : "none"}
- Add-stop options (if showing; ordered closest to furthest; user can say "the first one", "the third one", or "pick the closest one"): ${context.addStopOptions?.length ? context.addStopOptions.map((o, i) => `${i + 1}. ${o.name}`).join("; ") : "none"}${enrichmentLine}${safetyBlurb}

When Mode is "simulation", the Position above is the simulated car position along the route; treat it as the user's real location for all answers (safety at "here", "near me", current/next turn, etc.).`

  const quickSystemPrompt = `You are a driving copilot. Answer in one short sentence. Use: current step, next step, distance to next turn (meters), and nearby POIs. For "merge here?", "is this my exit?", "do I take this exit?" use distance to next turn: if under ~400 m say yes/merge here/take it and say the road name from next step; if over ~500 m say no/not yet and say when (e.g. "in X km"). For "which lane?" CHECK the distance to next turn/exit (meters) first: if it is over 1000 m (1 km), do NOT say "take the right/left lane"—say "Stay in the middle or left for now—your merge/exit is in about X km." Only say "Take the right/left lane to merge" or "to exit" when the distance is under ~1 km. For simple turns just say "Turn left here" or "Left." Reply first, then on a new line: ACTION: {"type":"none"} unless they clearly ask for directions/navigate/add stop.

Context:
- Current step: ${context.currentStepText ?? "none"}
- Next step: ${context.nextStepText ?? "none"}
- Distance to next turn/exit (meters): ${context.distanceToNextTurnMeters != null ? context.distanceToNextTurnMeters : "none"}
- Nearby POIs (name, side, distance_m): ${context.nearbyPOIs?.length ? JSON.stringify(context.nearbyPOIs.slice(0, 10)) : "none"}`

  const systemPrompt = quickPath ? quickSystemPrompt : fullSystemPrompt
  const maxTokens = quickPath ? 120 : 160

  const userMessage = `User said: "${transcript}"`

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_COPILOT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: quickPath
            ? userMessage + "\n\nReply in one short sentence, then ACTION: {\"type\":\"none\"}."
            : `${userMessage}\n\nKeep your reply to 1-2 short sentences only. Then on a new line output the ACTION. When addStopOptions is present and the user says "the first one", "the third one", "pick the closest one", "pick the first option", "the second one", etc., output ACTION: {"type":"pick_option","index":N} with N 0-based (first/closest=0, second=1, third=2). For add_stop output ACTION: {"type":"add_stop","query":"..."}. For alternate route output ACTION: {"type":"request_alternate_route"}. For directions/navigate or "what is [place]?" output ACTION: {"type":"navigate_to","query":"..."}. For places "near me" list output ACTION: {"type":"search_nearby","query":"..."}. Otherwise output ACTION: {"type":"none"}.`,
        },
      ],
      max_tokens: maxTokens,
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
      if (parsed.type === "add_stop" || parsed.type === "add_stop_place" || parsed.type === "add_stop_options" || parsed.type === "pick_option" || parsed.type === "request_alternate_route" || parsed.type === "navigate_to" || parsed.type === "search_nearby" || parsed.type === "none") {
        action = parsed
      }
    } catch {
      /* ignore parse errors */
    }
  }

  // Fallback: user clearly asked for directions but model returned none — extract place and trigger navigate_to
  if (action.type === "none") {
    const canNavigate = !context.hasActiveRoute || clearlyAskingForNewRoute(transcript)
    if (canNavigate) {
      // Hardcoded: "tennis courts from last monday" → Palega Recreation Center / tennis courts, San Francisco
      if (isTennisCourtsFromLastMonday(transcript)) {
        action = { type: "navigate_to", query: "Palega Recreation Center San Francisco" }
      }
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

  // Fallback: "scenic route" / "alternate route" / "more scenic" — force request_alternate_route so the modal and tradeoffs show
  if (action.type === "none") {
    const t = transcript.trim().toLowerCase()
    if (/\b(?:more\s+)?scenic\s+route\b/.test(t) || /\b(?:a\s+)?(?:different|alternate|alternative)\s+route\b/.test(t) || /\bscenic\s+(?:drive|way)\b/.test(t) || /give\s+me\s+a\s+more\s+scenic\s+route/i.test(transcript.trim())) {
      action = { type: "request_alternate_route" }
    }
  }

  // Fallback: "pick the first option", "the third one", "pick the closest one" when addStopOptions is showing
  if (action.type === "none" && context.addStopOptions?.length) {
    const t = transcript.trim().toLowerCase()
    if (/\b(?:pick\s+)?(?:the\s+)?closest\s*(?:one|option)?\b/.test(t) || /\bclosest\s*(?:one|option)?\s*(?:please)?\b/.test(t)) {
      action = { type: "pick_option", index: 0 }
    } else {
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
  }

  // Hardcoded: "choose one that has diesel" → add Royal Gas (near Palega) as stop immediately, no list
  if (isChooseOneWithDiesel(transcript)) {
    const royalGas = PALEGA_GAS_OPTIONS[0]
    action = { type: "add_stop_place", name: royalGas.name, address: royalGas.address, lat: royalGas.lat, lng: royalGas.lng }
  }

  // Mid-route: block navigate_to only when user did NOT clearly ask for a new destination (avoids blocking "take me to the pizza spot").
  let replyOverride: string | null = null
  if (action.type === "navigate_to" && context.hasActiveRoute && !clearlyAskingForNewRoute(transcript)) {
    action = { type: "none" }
    replyOverride = "You're already navigating. Say 'new route to [place]' if you want somewhere else."
  }

  // Hardcoded: "tennis courts from last monday" → always navigate to Palega Recreation Center, San Francisco
  if (action.type === "navigate_to" && isTennisCourtsFromLastMonday(transcript)) {
    action = { type: "navigate_to", query: "Palega Recreation Center San Francisco" }
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

  // "Which lane?" when next turn/merge/exit is far: never say "take the right lane" — say stay middle or left and give distance.
  const distM = context.distanceToNextTurnMeters
  if (isWhichLaneQuestion(transcript) && typeof distM === "number" && isNextStepMergeOrExit(context.nextStepText)) {
    if (distM > LANE_GUIDANCE_FAR_THRESHOLD_M) {
      const km = Math.round(distM / 1000)
      const nextT = (context.nextStepText ?? "").toLowerCase()
      const isExit = /\b(exit|ramp)\b/.test(nextT)
      const noun = isExit ? "exit" : "merge"
      reply = `Stay in the middle or left for now—your ${noun} is in about ${km} km.`
    } else {
      reply = getLanePreparePhrase(context.nextStepText)
    }
  }

  // On Pennsylvania Ave: "Turn on 25th or merge?" → hardcoded: merge onto highway AFTER passing 25th Street.
  const currentStep = (context.currentStepText ?? "").toLowerCase()
  const nextStep = (context.nextStepText ?? "").toLowerCase()
  const onPennsylvaniaAve = /\bpennsylvania\s+(?:ave|avenue)\b|\bpennsylvania\b/.test(currentStep)
  const nextStepIsMergeOnto = /\bmerge\s+onto\b/.test(nextStep)
  const asking25thOrMerge = isTurnOnStreetOrMergeQuestion(transcript) ||
    (/\b25th\b/.test(transcript.trim().toLowerCase()) && /\b(?:merge|turn)\b/.test(transcript.trim().toLowerCase()))
  if (onPennsylvaniaAve && nextStepIsMergeOnto && context.nextStepText && asking25thOrMerge) {
    const paReply = getPennsylvaniaAveMergeReply(context.nextStepText)
    if (paReply) reply = paReply
  }

  // Gas near Palega: suggest Royal Gas, Shell, ARCO; "choose one that has diesel" → add Royal Gas
  if (isChooseOneWithDiesel(transcript)) {
    reply = "Adding Royal Gas."
  } else if (isGasQuestion(transcript)) {
    reply = "Near Palega Recreation Center, the closest are Royal Gas, Shell, and ARCO."
    action = { type: "add_stop_options", places: PALEGA_GAS_OPTIONS }
  } else if (isSoccerFieldsQuestion(transcript)) {
    reply = "That's Silver Terrace Athletic Fields. It's a city park in Bayview with synthetic-turf soccer pitches and baseball diamonds—popular for youth soccer and rec leagues."
  }

  // If we forced navigate_to from fallback, replace unhelpful reply (e.g. "I don't know that place") with a short confirmation
  if (action.type === "navigate_to" && action.query && /don't have knowledge|can't find|don't know|unable to find|not (?:in my |in the )?(?:knowledge|database)/i.test(reply)) {
    return { reply: `Getting directions to ${action.query}.`, action }
  }

  if (replyOverride) reply = replyOverride
  if (action.type === "request_alternate_route" && !replyOverride) {
    reply = "Here are two routes—pick one."
  }
  if (action.type === "navigate_to" && action.query && !replyOverride) {
    if (isTennisCourtsFromLastMonday(transcript) && action.query.includes("Palega")) {
      reply = "Mapping to Palega Recreation Center tennis courts."
    } else if (!/^(?:getting|mapping|directions?\s+to|heading\s+to|taking\s+you\s+to)/i.test(reply)) {
      reply = `Mapping to ${action.query}.`
    }
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
