# Shotgun.ai — End-to-End Integration

## Overview

Verbal intent ("Add a stop to Starbucks") flows through OpenAI Realtime → `propose_stop` tool → Browser Use + Google Routes → verbal confirmation → Convex mutation → reactive map update.

## 1. Tool Definition (The Ear)

**OpenAI Realtime API** — Session created via `/api/realtime/call` (unified WebRTC interface) with three tools:

- **propose_stop** — `location_name` (string), `similar_category` (string, optional)  
  - When user says "Add a stop to [Place]"

- **confirm_add_stop** — no params  
  - When user says YES to add the proposed stop

- **cancel_proposal** — no params  
  - When user says NO to decline

## 2. The Agent (The Hands)

**Convex Action** `convex/agent.ts` → `proposeStop`:

1. Calls **Browser Use** `POST /api/v1/simple-search` with `BROWSER_USE_API_KEY`
2. Fallback: **Google Places Text Search** for coordinates
3. **Google Directions API**: origin→destination vs origin→waypoint→destination to compute `time_added` minutes
4. Returns `{ name, lat, lng, time_added }`

## 3. Verbal Handshake (Confirmation Flow)

- AI: "WE found a [Name]. It adds [X] minutes to our trip. Should WE add it?"
- User: "Yes" → `confirm_add_stop` → Convex `api.stops.addStop`
- User: "No" → `cancel_proposal` → clear pending, AI says "Understood, WE are sticking to the original route"

## 4. Reactive UI (The Map)

- `useQuery(api.stops.listStops)` watches the stops table
- When a stop is added, the map recalculates the route with waypoints via Directions API
- New path is applied via `setPath`

## 5. Glass HUD

- `LiveTranscriptionHUD` shows **AGENT SEARCHING…** when `agentStatus === "searching"`
- Uses `useRealtimeVoice` so Web Speech does not conflict with Realtime mic

## 6. Convex Environment Variables

Add these in your Convex dashboard (Settings → Environment Variables):

- `BROWSER_USE_API_KEY` — Browser Use API key
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — Google Maps/Places/Directions API key (or a server-only key)

## 7. Laminar Traces

Laminar `observe()` was removed from the API route due to Next.js/Turbopack bundling issues with `@lmnr-ai/lmnr`. To restore traces, use a different tracing approach or configure webpack to exclude the Laminar package from the API route bundle.

## Run

1. `npx convex dev` — push agent action, set env vars
2. `npm run dev` — start Next.js
3. Start navigation, say "Add a stop to Starbucks" (or similar) during turn-by-turn
