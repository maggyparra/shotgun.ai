# Mapbox MCP, Location Agent, and Your Copilot

This doc explains Mapbox’s AI/geospatial tools and how they relate to your app and to Cursor.

---

## What Mapbox offers

| Thing | What it is | Who uses it |
|-------|------------|-------------|
| **Mapbox MCP Server** | Geospatial APIs over MCP: directions, geocoding, POI search, isochrones, static maps. | Any AI that supports MCP (Cursor, Claude Desktop, etc.). |
| **Mapbox DevKit MCP Server** | Dev tools over MCP: map styles, tokens, GeoJSON preview, coordinate conversion. | AI coding assistants (Cursor, Copilot, Claude Code) when building Mapbox apps. |
| **Mapbox Location Agent** | Demo: LLM + MCP Server → conversational map (e.g. “Where can I have dinner with a view?”). | Request access; shows what’s possible. |
| **Mapbox MapGPT** | Product: voice, location-aware copilot for drivers (e.g. “How’s the weather on my route?”). | Via Mapbox Dash / SDK for OEMs. |

---

## Should you hook Cursor up to Mapbox MCP?

**Yes, if you want the AI in Cursor to be “map-aware” while you code.**

- **Mapbox MCP Server** (the main one) is the one that gives **geospatial intelligence**: directions, POI search, geocoding, isochrones. Adding this to Cursor gives the coding assistant (e.g. Cursor’s agent) tools to reason about places, routes, and proximity when helping you build or debug.
- **Mapbox DevKit** is for **Mapbox-specific dev tasks** (styles, tokens, formatting). Add it if you’re building Mapbox maps or switching parts of the app to Mapbox.

So:

- **For “AI understands what’s around me” while coding** → add **Mapbox MCP Server**.
- **For “AI helps me with Mapbox styles/tokens”** → add **Mapbox DevKit** (optional).

Your in-app voice copilot does **not** need to “talk to” the Mapbox MCP Server. The app can stay on Google Maps and still get much better context by calling **Mapbox REST APIs** (or more Google APIs) from your backend and feeding that into the LLM. MCP in Cursor is for the coding AI, not for the end-user copilot.

---

## How to add Mapbox MCP Server to Cursor

1. **Get a Mapbox access token**  
   Sign up at [mapbox.com](https://www.mapbox.com/signup) and create a token on the [Access Tokens](https://console.mapbox.com/account/access-tokens/) page.

2. **Configure Cursor’s MCP**  
   In Cursor: **Settings → MCP** (or edit the MCP config file Cursor uses).

   **Option A – Hosted (no local install)**  
   You’ll be prompted to sign in with Mapbox when you first use it:

   ```json
   {
     "mcpServers": {
       "mapbox-mcp": {
         "type": "http",
         "url": "https://mcp.mapbox.com/mcp"
       }
     }
   }
   ```

   **Option B – Local (with your token)**  
   Uses the npm package and your token:

   ```json
   {
     "mcpServers": {
       "MapboxServer": {
         "command": "npx",
         "args": ["-y", "@mapbox/mcp-server"],
         "env": {
           "MAPBOX_ACCESS_TOKEN": "YOUR_MAPBOX_ACCESS_TOKEN"
         }
       }
     }
   }
   ```

3. Restart Cursor (or reload MCP). The assistant can then use Mapbox tools (directions, POI, geocoding, etc.) when helping you.

---

## Making your in-app copilot more “location-aware”

Right now the copilot gets: position, heading, current/next step, destination, and nearby POIs (Google Places). To get **closer to Mapbox’s Location Agent / MapGPT** (e.g. “weather on my route”, “what’s around me”, better POI metadata), you have two main paths.

### Path 1: Enrich with Mapbox REST APIs (no MCP in the app)

Keep your map and routing on **Google**, but in `/api/copilot` (or a small service that builds context for the LLM):

- Call **Mapbox Directions API** for the current route (or segment) and pass summary (duration, distance, road names) into the prompt.
- Call **Mapbox Search Box / POI** (or **Mapbox Search – Retrieve**) for “places along route” or “near this point” and pass names, categories, and optional metadata into the prompt.
- Optionally add **isochrones** (“what’s within 5 min?”) and **reverse geocoding** for “what area am I in?”.

All of this is normal HTTP from your Next.js backend with a **server-side Mapbox token**; no MCP needed in the app. The LLM then has much richer spatial context (routes, POIs, areas) so it can answer like “how’s the weather on my route?” (once you add a weather API) or “what’s that building?” (from POI/metadata).

### Path 2: Stay on Google and add more Google APIs

- **Place Details** for “tell me more about that place” (hours, reviews, etc.).
- **Roads API** (snap to road, road metadata) for “what road am I on?” and road type.
- Keep feeding **current step / next step** and **nearby Places** into the copilot as you do now.

Either path improves “context and understanding of what’s going on around me” without running an MCP server inside the app.

---

## Recreating something like the Mapbox Location Agent

The Location Agent is essentially:

- **LLM** + **geospatial tools** (directions, POI, geocoding, isochrones) + **map UI**.

You already have:

- LLM (OpenAI in `/api/copilot`).
- Some geospatial context (Google Places, route steps, position).

To get closer to the demo:

1. **Add more structured context**  
   Route summary (current segment, ETA, road names), “POIs along route” or “nearby with categories”, and optionally reverse geocode / isochrones. Use either Mapbox or Google APIs from your backend.

2. **Optional: weather / traffic**  
   For “weather on my route” (MapGPT-style), add a weather API and pass “route segment” or “waypoints” so the LLM can say “weather on your route is …”.

3. **Keep one copilot endpoint**  
   Your `/api/copilot` (or a small “context builder” that then calls it) gathers position, route, POIs, and any extra APIs, then sends one rich context blob to the LLM. No need for a separate “location agent” process unless you want to scale it out later.

You do **not** need to run the Mapbox MCP Server inside your app to recreate this; calling Mapbox (or Google) REST APIs from your backend is enough.

---

## Summary

- **Cursor:** Add **Mapbox MCP Server** (and optionally **DevKit**) so the coding AI has geospatial (and Mapbox dev) tools. Use the config above.
- **In-app copilot:** Make it more location-aware by **enriching context** in your backend (Mapbox or Google APIs). No need to “hook the app” to Mapbox MCP.
- **Location-Agent-like experience:** Same idea – richer context (routes, POIs, area, optional weather/traffic) passed into the LLM from your backend; MCP is for Cursor, not for the end-user copilot.

If you want, next step can be: add a small “context enrichment” layer in `John's Folder` that calls Mapbox (or more Google) APIs and feeds that into the existing copilot route.
