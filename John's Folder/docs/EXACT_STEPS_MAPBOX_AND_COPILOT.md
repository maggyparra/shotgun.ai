# Exact Steps: Mapbox MCP in Cursor + Smarter In-App Copilot

Follow these in order. Copy-paste where possible.

---

## Part 1: Add Mapbox MCP Server to Cursor (so the coding AI has map tools)

### Step 1.1 – Get a Mapbox access token

1. Open: **https://www.mapbox.com/signup**
2. Create an account (or sign in).
3. Open: **https://console.mapbox.com/account/access-tokens/**
4. Click **Create a token**.
5. Name it (e.g. `Cursor MCP`). Leave defaults (or restrict to what you need).
6. Click **Create token**.
7. **Copy the token** and keep it somewhere safe (you’ll paste it in Step 1.3).

---

### Step 1.2 – Open Cursor’s MCP settings

**On Mac:**

- Press **`Cmd + ,`** (or menu **Cursor → Settings**).
- In the left sidebar, open **Tools & MCP** (or **Features → MCP**).
- You should see **MCP Servers** and an option to add or edit servers.

**On Windows:**

- Press **`Ctrl + ,`** (or **File → Preferences → Settings**).
- Go to **Tools & MCP** (or **Features → MCP**).

---

### Step 1.3 – Add the Mapbox MCP Server (choose one method)

**Method A – Using Cursor’s UI**

1. In **MCP** settings, click **Add new MCP server** (or **Edit mcp.json**).
2. If it opens a JSON file, use **Method B** instead.
3. If it shows a form:
   - **Name:** `MapboxServer` (or `mapbox-mcp`).
   - **Command:** `npx`
   - **Args:** `-y`, `@mapbox/mcp-server`
   - **Env:** add a variable:
     - Key: `MAPBOX_ACCESS_TOKEN`
     - Value: *(paste the token you copied in Step 1.1)*
4. Save.

**Method B – Using the config file (recommended)**

1. In your **project** (e.g. `John's Folder`), create the folder **`.cursor`** if it doesn’t exist.
2. Create or open the file **`.cursor/mcp.json`** in that folder.
3. Put this inside (replace `YOUR_MAPBOX_ACCESS_TOKEN` with your real token):

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

4. Save the file.

**Alternative – Hosted Mapbox MCP (no token in file)**

If you prefer the hosted endpoint and OAuth sign-in:

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

Save. The first time you use it, Cursor will prompt you to sign in with Mapbox in the browser.

---

### Step 1.4 – Restart Cursor

1. Quit Cursor completely (e.g. **Cmd + Q** on Mac, or **File → Exit** on Windows).
2. Open Cursor again and open your project.
3. MCP servers load at startup; Mapbox tools should now be available to the AI when you chat or use the agent.

**Check:** In a chat, you can ask: “Use Mapbox to get driving directions from [address A] to [address B].” If the AI can call Mapbox tools, the setup worked.

---

## Part 2: Make the in-app copilot more location-aware (backend enrichment)

These steps add **Mapbox APIs** to your existing copilot so it gets route summary, nearby POIs from Mapbox, and reverse geocoding (area name). Your map stays on Google; only the **context** sent to the LLM is enriched.

### Step 2.1 – Add your Mapbox token to the app

1. Open **`John's Folder/.env.local`** (create it if it doesn’t exist).
2. Add this line (use the same token as in Part 1, or a separate token with only the APIs you need):

```bash
MAPBOX_ACCESS_TOKEN=pk.your_actual_token_here
```

3. Save. (Do not commit `.env.local` to git.)

---

### Step 2.2 – Install nothing extra

The enrichment uses only `fetch` and your existing Next.js API route. No new npm packages are required.

---

### Step 2.3 – Use the new enrichment in the copilot

The project now includes:

- **`src/lib/copilot-enrichment.ts`** – builds extra context from Mapbox (reverse geocode, nearby POIs, optional route summary).
- **`src/app/api/copilot/route.ts`** – updated to call the enricher and pass the result into the LLM prompt.

You don’t need to change anything else. When the frontend sends a request to `/api/copilot` with the existing `context` (position, route, etc.), the backend will:

1. Call Mapbox reverse geocoding for the current position → “area name”.
2. Optionally call Mapbox Search for nearby POIs (if you’re not on a route or want extra POIs).
3. Append this to the system prompt so the LLM sees “Current area: …” and richer POI/location info.

---

### Step 2.4 – Test the in-app copilot

1. From **`John's Folder`**, run:

   ```bash
   npm run dev
   ```

2. Open **http://localhost:3000**.
3. Allow location (or start a simulation).
4. Tap the **mic** and ask something like:
   - “What area am I in?”
   - “What’s around me?”
5. The reply should use the Mapbox-enriched context (e.g. neighborhood/city name from reverse geocoding).

---

## Quick reference

| Goal | What to do |
|------|------------|
| **Cursor AI has Mapbox tools** | Part 1: token → Cursor MCP config → restart Cursor. |
| **In-app copilot knows area + more POIs** | Part 2: add `MAPBOX_ACCESS_TOKEN` to `.env.local`; code is already wired in `copilot-enrichment.ts` and `/api/copilot`. |
| **Config file location** | Project: `John's Folder/.cursor/mcp.json`; global: `~/.cursor/mcp.json`. |
| **MCP not loading** | Fully quit Cursor (Cmd+Q / Exit) and open again. |

If anything in Part 2 is missing (e.g. `copilot-enrichment.ts` or changes to `route.ts`), say what you see in the project and we can add the exact code next.
