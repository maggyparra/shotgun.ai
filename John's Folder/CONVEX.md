# Convex (single source of truth)

This app uses **one** Convex backend. All Convex code lives in **John's Folder**: `John's Folder/convex/`.

## Quick reference

| What | Where |
|------|--------|
| **Backend code** | `convex/` (schema, stops, agent) |
| **Dev URL** | Set by `npx convex dev` → `.env.local` as `NEXT_PUBLIC_CONVEX_URL` |
| **CLI** | Run from **John's Folder**: `npx convex dev`, `npx convex deploy` |

## First-time / new machine

1. From **John's Folder** run:
   ```bash
   cd "John's Folder"
   npx convex dev
   ```
2. Log in or create a Convex account if prompted.
3. Convex will create a dev deployment and print a URL. It will also write `NEXT_PUBLIC_CONVEX_URL=...` to `.env.local` in John's Folder (or you paste it there).
4. Restart the Next.js dev server so it picks up the env var.

## Daily development

- **Run Convex in the background** (from John's Folder):
  ```bash
  cd "John's Folder"
  npx convex dev
  ```
  Leave this running while you code. It syncs your `convex/` functions and regenerates `convex/_generated/`.

## Deploying to production

From John's Folder:

```bash
cd "John's Folder"
npx convex deploy
```

Answer **Y** to push to your prod deployment. Your hosted app (e.g. Vercel) must use the **same** `NEXT_PUBLIC_CONVEX_URL` as the prod deployment (the URL Convex shows after deploy).

## Making changes to Convex

1. Edit files under `convex/` (e.g. `schema.ts`, `stops.ts`, `agent.ts`).
2. Save. If `npx convex dev` is running, it will push changes and regenerate `_generated/`.
3. If you add new functions or change the schema, the frontend will get new types from `convex/_generated/`; no need to run anything else for types.

## What’s in this backend

- **Schema** (`schema.ts`): `stops` table (label, placeId, lat, lng, taskHint, createdAt).
- **stops.ts**: `addStop`, `listStops`, `removeStop` (mutations + query for map pins).
- **agent.ts**: `proposeStop` action (Google Places + Directions for “add a stop” flows).

The map reads `listStops` for the purple stop markers. The **route line** is driven by the app’s navigation state (Google Directions → path); Convex does not draw the line.
