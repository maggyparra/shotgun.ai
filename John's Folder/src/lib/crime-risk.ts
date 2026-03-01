/**
 * Crime-risk aware arrival & safer parking suggestion (backend-only).
 * Used by the voice copilot to answer "is it safe to park here?" and to warn when
 * approaching a high-crime area within 1–2 minutes of destination.
 *
 * Data sources (first applicable wins when in range):
 * - In San Francisco: DataSF (Socrata) Police Department Incident Reports — no API key.
 * - Otherwise: CRIMEOMETER_API_KEY (https://www.crimeometer.com/) or NUMBEO_API_KEY (https://www.numbeo.com/api/doc.jsp).
 * Without any configured source, the copilot will say safety data isn't available.
 */

export type CrimeRiskResult = {
  riskLevel: "low" | "medium" | "high" | "unknown"
  summary: string
  /** Note specific to vehicle/carjacking risk when relevant */
  carjackingNote?: string
  /** Safer parking suggestion when risk is elevated */
  saferParkingSuggestion?: string
  /** Optional: incident count in window (for logging/debug) */
  incidentCount?: number
  /** Optional: neighborhood or area label (e.g. "Mission", "Outer Sunset") for variety across city */
  areaLabel?: string
}

const RADIUS_MILES_DEFAULT = 0.5
const DAYS_LOOKBACK = 90

/** San Francisco bounding box for DataSF (includes SFO, South SF, and nearby) */
const SF_BOUNDS = {
  latMin: 37.65,
  latMax: 37.85,
  lngMin: -122.55,
  lngMax: -122.30,
}

function isInSanFrancisco(lat: number, lng: number): boolean {
  return (
    lat >= SF_BOUNDS.latMin &&
    lat <= SF_BOUNDS.latMax &&
    lng >= SF_BOUNDS.lngMin &&
    lng <= SF_BOUNDS.lngMax
  )
}

/** FBI NIBRS / Crimeometer offense types we treat as vehicle-related or violent (carjacking risk) */
const VEHICLE_OR_VIOLENT_OFFENSES = [
  "motor vehicle theft",
  "vehicle theft",
  "auto theft",
  "theft from motor vehicle",
  "robbery",
  "carjacking",
  "car jacking",
  "armed robbery",
  "strong-arm robbery",
  "theft - from vehicle",
  "larceny from auto",
]

/** DataSF/SFPD incident_category values we treat as vehicle-related or violent (parking safety) */
const DATASF_VEHICLE_OR_VIOLENT = [
  "motor vehicle theft",
  "robbery",
  "stolen property",
  "burglary", // break-in to vehicle often categorized here
]

function normalizeOffense(type: string): string {
  return (type || "").toLowerCase().trim()
}

function isDataSFVehicleOrViolent(category: string): boolean {
  const n = normalizeOffense(category)
  return DATASF_VEHICLE_OR_VIOLENT.some((c) => n.includes(c) || c.includes(n))
}

function isVehicleOrViolentOffense(offense: string): boolean {
  const n = normalizeOffense(offense)
  return VEHICLE_OR_VIOLENT_OFFENSES.some((o) => n.includes(o) || o.includes(n))
}

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
  return R * c
}

/** DataSF (Socrata): SFPD incident reports — SF only, no API key. */
const DATASF_INCIDENT_RESOURCE = "wg3w-h783"
const DATASF_BASE = "https://data.sfgov.org/resource"

async function tryDataSF(
  lat: number,
  lng: number,
  radiusMeters: number
): Promise<CrimeRiskResult | null> {
  if (!isInSanFrancisco(lat, lng)) return null
  try {
    const radius = Math.min(radiusMeters, 450)
    const where = `within_circle(point, ${lat}, ${lng}, ${radius})`
    const select = "incident_category,incident_subcategory,analysis_neighborhood"
    const url = `${DATASF_BASE}/${DATASF_INCIDENT_RESOURCE}.json?$where=${encodeURIComponent(where)}&$select=${encodeURIComponent(select)}&$order=incident_datetime desc&$limit=500`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{
      incident_category?: string
      incident_subcategory?: string
      analysis_neighborhood?: string
    }>
    const vehicleOrViolent = rows.filter(
      (r) =>
        isDataSFVehicleOrViolent(r.incident_category ?? "") ||
        isDataSFVehicleOrViolent(r.incident_subcategory ?? "")
    )
    const count = vehicleOrViolent.length
    const byNeighborhood = new Map<string, number>()
    for (const r of vehicleOrViolent) {
      const n = (r.analysis_neighborhood ?? "Unknown").trim()
      if (n) byNeighborhood.set(n, (byNeighborhood.get(n) ?? 0) + 1)
    }
    const areaLabel =
      byNeighborhood.size > 0
        ? [...byNeighborhood.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : undefined
    let riskLevel: CrimeRiskResult["riskLevel"] = "low"
    if (count >= 9) riskLevel = "high"
    else if (count >= 3) riskLevel = "medium"
    const radiusMiles = radius / 1609.34
    const summary =
      count === 0
        ? "No vehicle-related or violent incidents reported in this immediate area in recent SFPD data (San Francisco)."
        : `In recent SFPD data, ${count} vehicle-related or violent incident${count === 1 ? "" : "s"} ${count === 1 ? "was" : "were"} reported within about ${radiusMiles.toFixed(2)} mile(s) of this location in San Francisco.`
    const carjackingNote =
      riskLevel !== "low"
        ? "Elevated vehicle-related crime in the area. Be aware of your surroundings when parking and exiting the vehicle."
        : undefined
    const saferParkingSuggestion =
      riskLevel !== "low"
        ? "Consider parking in a well-lit, busier area if possible, or closer to main streets and foot traffic."
        : undefined
    return {
      riskLevel,
      summary,
      carjackingNote,
      saferParkingSuggestion,
      incidentCount: count,
      areaLabel,
    }
  } catch {
    return null
  }
}

/** Numbeo: city-level crime index (0–100). Accepts lat,lng as query. */
async function tryNumbeo(lat: number, lng: number): Promise<CrimeRiskResult | null> {
  const apiKey = process.env.NUMBEO_API_KEY
  if (!apiKey) return null
  try {
    const query = `${lat},${lng}`
    const url = `https://www.numbeo.com/api/city_crime?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const data = (await res.json()) as {
      index_crime?: number
      index_safety?: number
      name?: string
      worried_things_car_stolen?: number
    }
    const indexCrime = data.index_crime
    if (typeof indexCrime !== "number") return null
    const cityName = data.name ?? "this area"
    let riskLevel: CrimeRiskResult["riskLevel"] = "low"
    if (indexCrime >= 60) riskLevel = "high"
    else if (indexCrime >= 35) riskLevel = "medium"
    const summary =
      `Crime index for ${cityName} is ${Math.round(indexCrime)} out of 100 (lower is safer). ` +
      (riskLevel === "low"
        ? "This area is generally on the safer side."
        : riskLevel === "medium"
          ? "Moderate risk—use normal caution."
          : "Higher crime area—be extra cautious when parking.")
    const carStolenWorry = data.worried_things_car_stolen
    const carjackingNote =
      riskLevel !== "low" || (typeof carStolenWorry === "number" && carStolenWorry > 0)
        ? "Be aware of your surroundings when parking and exiting the vehicle."
        : undefined
    const saferParkingSuggestion =
      riskLevel !== "low"
        ? "Consider parking in a well-lit, busier area or closer to main streets and foot traffic."
        : undefined
    return {
      riskLevel,
      summary,
      carjackingNote,
      saferParkingSuggestion,
    }
  } catch {
    return null
  }
}

/**
 * Fetch crime risk for an area. Uses Crimeometer API when CRIMEOMETER_API_KEY is set.
 * Returns unknown/neutral result when key is missing or API fails (backend stays safe, no frontend impact).
 */
export async function getCrimeRiskForArea(
  lat: number,
  lng: number,
  radiusMeters?: number
): Promise<CrimeRiskResult> {
  const radiusMiles = radiusMeters != null ? radiusMeters / 1609.34 : RADIUS_MILES_DEFAULT
  const radiusM = radiusMeters ?? RADIUS_MILES_DEFAULT * 1609.34

  // San Francisco: use DataSF (Socrata) first — no API key
  if (isInSanFrancisco(lat, lng)) {
    const dataSFResult = await tryDataSF(lat, lng, Math.round(radiusM))
    if (dataSFResult) return dataSFResult
  }

  const apiKey = process.env.CRIMEOMETER_API_KEY

  if (!apiKey) {
    const numbeoResult = await tryNumbeo(lat, lng)
    if (numbeoResult) return numbeoResult
    return {
      riskLevel: "unknown",
      summary:
        "Safety data is NOT configured for this app. Tell the user: crime and carjacking risk is not enabled—whoever set up the app can add CRIMEOMETER_API_KEY (or NUMBEO_API_KEY) to .env.local to enable it. Until then, recommend parking in well-lit, busy areas. Do NOT say 'I don't have crime data for this area'; say it's not configured for the app.",
    }
  }

  const now = new Date()
  const end = new Date(now)
  const start = new Date(now)
  start.setDate(start.getDate() - DAYS_LOOKBACK)
  const datetime_ini = start.toISOString().slice(0, 19).replace("T", " ")
  const datetime_end = end.toISOString().slice(0, 19).replace("T", " ")

  try {
    const url = new URL("https://api.crimeometer.com/v1/incidents/raw-data")
    url.searchParams.set("lat", String(lat))
    url.searchParams.set("lon", String(lng))
    url.searchParams.set("distance", String(Math.max(0.1, radiusMiles)))
    url.searchParams.set("datetime_ini", datetime_ini)
    url.searchParams.set("datetime_end", datetime_end)
    url.searchParams.set("page", "1")

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      const text = await res.text()
      console.warn("[crime-risk] Crimeometer API error:", res.status, text.slice(0, 200))
      const numbeoResult = await tryNumbeo(lat, lng)
      if (numbeoResult) return numbeoResult
      return {
        riskLevel: "unknown",
        summary: "Safety data for this area is temporarily unavailable. Park in well-lit, busy areas when possible.",
      }
    }

    const data = (await res.json()) as {
      total_incidents?: number
      incidents?: Array<{ incident_offense?: string; incident_offense_code?: string }>
    }

    const incidents = data.incidents ?? []
    const total = data.total_incidents ?? incidents.length
    const vehicleOrViolent = incidents.filter((i) =>
      isVehicleOrViolentOffense(i.incident_offense ?? i.incident_offense_code ?? "")
    )
    const count = vehicleOrViolent.length

    // Heuristic: low = 0–2, medium = 3–8, high = 9+ in 90 days in 0.5 mi radius
    let riskLevel: CrimeRiskResult["riskLevel"] = "low"
    if (count >= 9) riskLevel = "high"
    else if (count >= 3) riskLevel = "medium"

    let summary: string
    let carjackingNote: string | undefined
    let saferParkingSuggestion: string | undefined

    if (count === 0) {
      summary = "No vehicle-related or violent incidents reported in this immediate area in the last 90 days."
    } else {
      summary = `In the last 90 days, ${count} vehicle-related or violent incident${count === 1 ? "" : "s"} ${count === 1 ? "was" : "were"} reported within about ${radiusMiles.toFixed(1)} mile(s) of this location.`
      if (riskLevel !== "low") {
        carjackingNote =
          "Elevated vehicle-related crime in the area. Be aware of your surroundings when parking and exiting the vehicle."
        saferParkingSuggestion =
          "Consider parking in a well-lit, busier area if possible, or closer to main streets and foot traffic."
      }
    }

    return {
      riskLevel,
      summary,
      carjackingNote,
      saferParkingSuggestion,
      incidentCount: count,
    }
  } catch (e) {
    console.warn("[crime-risk] fetch failed:", (e as Error)?.message)
    const numbeoResult = await tryNumbeo(lat, lng)
    if (numbeoResult) return numbeoResult
    return {
      riskLevel: "unknown",
      summary: "Safety data for this area could not be loaded. Use general caution and prefer well-lit, busy parking.",
    }
  }
}

/**
 * Returns true if the user is roughly within 1–2 minutes drive of destination
 * (straight-line distance &lt; ~2 km as a proxy for "last mile").
 */
export function isWithinOneToTwoMinutesOfDestination(
  position: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): boolean {
  const meters = haversineMeters(position, destination)
  return meters <= 2000
}
