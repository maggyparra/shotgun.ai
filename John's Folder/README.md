# Shotgun Map

A lightweight, Google Maps–style web app with **turn-by-turn instructions**, **map display**, and **address search**. No API key required to run (uses free OSM + OSRM).

## What’s included

- **Turn-by-turn instructions** in the sidebar (distance + text per step)
- **Route line** on the map with total distance and time
- **Address search** (From / To) via Nominatim geocoding
- **Click map** to set start (first click) and destination (second click)
- **Follow mode**: local overhead view that keeps the map centered on your location (GPS) as you move
- **Simulate drive**: after getting a route, run a simulated drive along the path with the same overhead follow view (no GPS needed)
- **OpenStreetMap** tiles and **OSRM** routing (free, open source)

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 and enter two addresses (e.g. “Times Square, NYC” and “Brooklyn Bridge, NYC”), then click **Get route**.

## Stack

| Piece        | Tech              | Notes                                      |
|-------------|-------------------|--------------------------------------------|
| Map         | [Leaflet](https://leafletjs.com/) | Renders OSM tiles and route line           |
| Routing UI  | [Leaflet Routing Machine](https://github.com/perliedman/leaflet-routing-machine) | Turn-by-turn + OSRM integration |
| Routing API | [OSRM](https://project-osrm.org/) (public demo) | 1 request/sec limit; demo only            |
| Geocoding   | [Nominatim](https://nominatim.openstreetmap.org/) | OSM geocoding; ~1 req/sec                  |

## Production / “faster” options

The app is wired so you can swap the routing backend without changing the UI:

1. **Mapbox Directions API**  
   - Free tier: 100k requests/month.  
   - In `src/main.js`, use `L.Routing.mapbox('YOUR_ACCESS_TOKEN')` as the `router` instead of `L.Routing.osrmv1(...)`.

2. **GraphHopper**  
   - Free tier available.  
   - Use the [lrm-graphhopper](https://github.com/perliedman/lrm-graphhopper) plugin and pass it as `router`.

3. **Self-hosted OSRM**  
   - No rate limit; you control updates.  
   - Set `router: L.Routing.osrmv1({ serviceUrl: 'https://your-osrm-server/route/v1' })`.

4. **Google Maps**  
   - **Fully usable for web**: use the [Maps JavaScript API](https://developers.google.com/maps/documentation/javascript) with the [Directions API](https://developers.google.com/maps/documentation/directions) or [Routes API](https://developers.google.com/maps/documentation/routes) for routing and turn-by-turn. The *Navigation SDK* is Android/iOS-only; for web you use the JS API + Directions/Routes.  
   - Best data quality and traffic; pay-per-use pricing.

## Attribution

- © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors  
- Routing: [OSRM](https://project-osrm.org/)

## Build

```bash
npm run build
npm run preview
```

Built files are in `dist/`.
