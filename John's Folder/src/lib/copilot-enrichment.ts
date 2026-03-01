/**
 * Enrich copilot context with Mapbox (reverse geocoding) and weather (Open-Meteo).
 * Mapbox: add MAPBOX_ACCESS_TOKEN to .env.local.
 * Weather: no key required (Open-Meteo).
 */

export type EnrichmentResult = {
  areaName: string | null
  weather: {
    atPosition: string | null
    atDestination: string | null
  }
}

async function fetchWeatherAt(lat: number, lng: number): Promise<string | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,precipitation&timezone=auto`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number; precipitation?: number }
    }
    const c = data.current
    if (!c) return null
    const temp = c.temperature_2m != null ? Math.round(c.temperature_2m) : null
    const code = c.weather_code ?? 0
    const desc =
      code === 0 ? "clear" : code <= 3 ? "partly cloudy" : code <= 48 ? "foggy" : code <= 67 ? "rain" : code <= 77 ? "snow" : "mixed"
    const parts: string[] = []
    if (temp != null) parts.push(`${temp}°C`)
    parts.push(desc)
    if (c.precipitation != null && c.precipitation > 0) parts.push(`, ${c.precipitation} mm precip`)
    return parts.join(" ")
  } catch {
    return null
  }
}

export async function enrichCopilotContext(
  position: { lat: number; lng: number },
  destination?: { lat: number; lng: number } | null
): Promise<EnrichmentResult> {
  const token = process.env.MAPBOX_ACCESS_TOKEN
  const result: EnrichmentResult = {
    areaName: null,
    weather: { atPosition: null, atDestination: null },
  }

  const { lat, lng } = position

  try {
    result.weather.atPosition = await fetchWeatherAt(lat, lng)
  } catch {
    // ignore
  }

  if (destination && (destination.lat !== lat || destination.lng !== lng)) {
    try {
      result.weather.atDestination = await fetchWeatherAt(destination.lat, destination.lng)
    } catch {
      // ignore
    }
  }

  if (token) {
    try {
      const revUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${encodeURIComponent(token)}&limit=1&types=place,neighborhood,locality,address`
      const revRes = await fetch(revUrl)
      if (revRes.ok) {
        const revData = (await revRes.json()) as {
          features?: Array<{ place_name?: string; text?: string }>
        }
        const first = revData.features?.[0]
        if (first?.place_name) result.areaName = first.place_name
        else if (first?.text) result.areaName = first.text
      }
    } catch {
      // ignore
    }
  }

  return result
}

export function formatEnrichmentForPrompt(enrichment: EnrichmentResult): string {
  const parts: string[] = []
  if (enrichment.areaName) {
    parts.push(`Current area (Mapbox reverse geocode): ${enrichment.areaName}`)
  }
  if (enrichment.weather.atPosition) {
    parts.push(`Weather at your position: ${enrichment.weather.atPosition}`)
  }
  if (enrichment.weather.atDestination) {
    parts.push(`Weather at destination: ${enrichment.weather.atDestination}`)
  }
  return parts.length > 0 ? "\n" + parts.join("\n") : ""
}
