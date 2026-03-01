# Shotgun.ai

Next.js + Google Maps + Convex navigation app with voice copilot.

- **Slow simulation** — Drive sim runs at ~1.2s per step so you can follow along.
- **Map follows you** — Map centers on your current position at zoom 17 and pans as you move.
- **Turn-by-turn banner** — Fixed bar at the top shows the *next* instruction and distance to that turn (e.g. "Turn left onto Main St" · "in 240 m"). Updates after you pass each step.
- **Voice copilot** — Tap the mic (bottom-right) to talk. Ask for navigation help ("before or after the McDonald's?"), add a stop, "what's that on the left?", "how's the weather on my route?", or general questions. Uses Web Speech API for speech-to-text; replies use **MiniMax TTS** (human-like) when `MINIMAX_API_KEY` is set, else browser TTS. Context includes position, route, nearby POIs (with distance and left/right), area (Mapbox), and weather.

## Run locally

1. Create `.env.local` in **John's Folder** with:
   - `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`
   - `OPENAI_API_KEY` (for the voice copilot AI)
   - Optional: `MAPBOX_ACCESS_TOKEN` (area name + enrichment), `MINIMAX_API_KEY` (human-like TTS)
2. From **John's Folder**:
   ```bash
   cd "John's Folder"
   npm install
   npx convex dev   # leave running in one terminal
   npm run dev      # in another terminal
   ```
3. Open [http://localhost:3000](http://localhost:3000). Click the map to set a destination, then **Go (slow simulation)**.

See **CONVEX.md** for Convex setup details (first-time and for new clones).

## Stack

- Next.js 16, React 19
- Google Maps (Directions, Places, Geometry)
- Convex (stops, agent actions)
