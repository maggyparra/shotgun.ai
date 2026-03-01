# Hackathon: Go Beyond Mapbox & Win

## What Mapbox Already Offers (so we don’t just repeat it)

- **Directions** – Driving, walking, cycling; traffic-aware; turn-by-turn
- **Geocoding** – Forward and reverse (address ↔ coordinates)
- **Search / POI** – Places, addresses, categories; Search Box API
- **Isochrones** – “What’s reachable in X minutes?”
- **Map Matching** – Snap GPS traces to roads
- **Matrix API** – Travel times between many points
- **Optimization API** – Best order for multiple stops
- **Static Maps** – Raster map images
- **EV Charge Finder** (beta) – Charging stations
- **MCP Server** – Expose the above to AI agents (Cursor, etc.)

So: **routing, search, geocoding, isochrones, traffic, optimization, static maps** are “table stakes.” To stand out, you need features and UX that sit **on top** of this.

---

## How to Go Beyond Mapbox (differentiation ideas)

1. **Voice-first, human-like copilot**
   - Mapbox gives data; they don’t own the **voice** or the **conversation**. Use **MiniMax TTS** so the copilot sounds natural and consistent (not robotic browser TTS). That’s a clear “beyond Mapbox” win.

2. **“What’s on my left/right” that’s actually close**
   - Mapbox/Google can return nearby POIs, but **which** one is “on my left” and **how close** is product logic. We fixed this by: **distance_m** on every POI, **smaller radius (200 m)**, **sort by distance**, and instructing the LLM to **pick the closest POI on the requested side** and to **not** name something far away (e.g. two streets away). That’s a UX layer on top of raw POI data.

3. **Weather on the journey**
   - Mapbox doesn’t do weather. Adding **weather at current position + at destination** (e.g. Open-Meteo) and letting the user ask “How’s the weather on my route?” is a clear extra.

4. **Real vs simulation mode**
   - One mode uses **real GPS** (snap to route); the other is **pure simulation** with no jumping. Clean separation and one dot = better demo than “sometimes it jumps.”

5. **Single context, smart answers**
   - One backend call that **enriches** context (Mapbox reverse geocode, weather, POIs with distance and side) and sends **one** prompt to the LLM. The model answers from that mix (general knowledge + location + weather). That’s “intelligent switching” without separate routers.

6. **Ideas that go even further (hackathon stretch)**
   - **Scenic score** – Score route segments by greenery/view (e.g. land cover or elevation) and say “the next 2 miles are the scenic part.”
   - **Safety / comfort** – Prefer or annotate routes by road type, lighting, or incident history if you have data.
   - **Carbon / efficiency** – Estimate CO₂ or fuel use per route and offer “greenest route.”
   - **Local knowledge** – “Construction on X St” or “Event at Y” from a feed, and surface in voice.
   - **Accessibility** – “Stops with step-free access” or “route with curb ramps” if you have accessibility data.
   - **Multi-stop optimization** – Use Mapbox Optimization and expose it via voice: “Add a coffee stop and a gas stop in the best order.”

---

## What We Use MiniMax For (and what else it can do)

**Current use**

- **TTS (Text-to-Speech)** – Copilot replies are spoken with MiniMax T2A when `MINIMAX_API_KEY` is set (fallback: browser `speechSynthesis`). Sounds more human-like and consistent.

**Other useful MiniMax capabilities**

- **Voice cloning** – Clone a specific voice (e.g. “your” brand voice) from a short sample; use it for TTS so the copilot has a recognizable character.
- **Emotion control** – TTS supports emotions (neutral, happy, sad, etc.); you could tune the copilot tone (e.g. calmer in heavy traffic).
- **Long-form / async TTS** – For very long replies (e.g. trip summary), use async TTS and stream or play when ready.
- **STT (if they offer)** – If MiniMax has speech-to-text, you could unify voice pipeline (MiniMax for both listen and speak) for consistency; today we use Web Speech API for STT.

So: **better voice** is the main win; **voice clone + emotion** are strong differentiators for a hackathon.

---

## What We Fixed: “On my left” naming something two streets away

**Cause**

- POIs came from a **600 m** radius, so many results were far away.
- No **distance** in context, so the model couldn’t prefer “closest on left.”
- No instruction to **avoid** naming far POIs for “what’s on my left/right.”

**Changes**

- **Radius 200 m** – Only nearby places (roughly one block to a few blocks).
- **distance_m** – Every POI has distance in meters from current position.
- **Sort by distance** – Closest first; we send the top 15.
- **Prompt** – “Pick the CLOSEST POI on the requested side (smallest distance_m). Do NOT name a place that is far (e.g. over 100 m); if the only POI on that side is far, say you don’t see something close on that side.”

So the copilot now prefers the **closest** place on your left/right and avoids naming something two streets away.

---

## Checklist for “above and beyond” in the hackathon

- [x] Human-like voice (MiniMax TTS when key set)
- [x] Weather on journey (current + destination)
- [x] “What’s on my left/right” = closest on that side (distance + radius + prompt)
- [x] Real vs simulation mode (no jumping)
- [x] Mapbox MCP in Cursor (geospatial tools for development)
- [x] Enriched context (area, weather, POIs with side + distance) in one LLM call
- [ ] Optional: scenic/safety/carbon/accessibility or local-events layer (stretch)
- [ ] Optional: MiniMax voice clone or emotion for a signature copilot voice (stretch)
