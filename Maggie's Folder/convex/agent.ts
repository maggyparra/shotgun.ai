"use node"

/**
 * Agent actions: propose_stop flow — find the CLOSEST [Place] and return { name, lat, lng, time_added }.
 * Uses multiple fallbacks so we ALWAYS find a place; failing is not an option.
 */

import { action } from "./_generated/server"
import { v } from "convex/values"

type PlaceResult = { name: string; lat: number; lng: number }

function parsePlace(
  raw: { name?: string; displayName?: { text?: string }; geometry?: { location?: { lat?: number; lng?: number } }; location?: { latitude?: number; longitude?: number } },
  fallbackName: string
): PlaceResult | null {
  const lat = raw?.geometry?.location?.lat ?? raw?.location?.latitude
  const lng = raw?.geometry?.location?.lng ?? raw?.location?.longitude
  if (lat == null || lng == null) return null
  const name = raw?.displayName?.text ?? raw?.name ?? fallbackName
  return { name, lat, lng }
}

export const proposeStop = action({
  args: {
    locationName: v.string(),
    similarCategory: v.optional(v.string()),
    originLat: v.number(),
    originLng: v.number(),
    destLat: v.number(),
    destLng: v.number(),
  },
  handler: async (ctx, args) => {
    const googleKey =
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY
    if (!googleKey) {
      return { error: "Missing Google Maps API key", name: "", lat: 0, lng: 0, time_added: 0 }
    }

    const keyword = args.locationName.trim().split(/\s+/)[0] || args.locationName
    let placeResult: PlaceResult | null = null
    const rawErrors: string[] = []

    // 1. New Places API (searchText) — closest-first with location bias
    try {
      const newPlacesRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleKey,
          "X-Goog-FieldMask": "places.displayName,places.location",
        },
        body: JSON.stringify({
          textQuery: keyword,
          rankPreference: "DISTANCE",
          locationBias: {
            circle: {
              center: { latitude: args.originLat, longitude: args.originLng },
              radius: 50000,
            },
          },
        }),
      })
      const newPlacesBody = (await newPlacesRes.json()) as {
        places?: unknown[]
        error?: { code?: number; message?: string; status?: string }
      }
      if (newPlacesRes.ok && newPlacesBody?.places?.[0]) {
        placeResult = parsePlace(newPlacesBody.places[0] as Parameters<typeof parsePlace>[0], args.locationName)
      } else {
        rawErrors.push(`NewPlaces: ${newPlacesRes.status} ${JSON.stringify(newPlacesBody?.error ?? newPlacesBody).slice(0, 200)}`)
      }
    } catch (e) {
      rawErrors.push(`NewPlaces: ${String((e as Error)?.message ?? e)}`)
    }

    // 2. Legacy Nearby Search (rankby=distance)
    if (!placeResult) {
      try {
        const nearbyRes = await fetch(
          `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${args.originLat},${args.originLng}&rankby=distance&keyword=${encodeURIComponent(keyword)}&key=${googleKey}`
        )
        const nearbyData = (await nearbyRes.json()) as {
          status?: string
          error_message?: string
          results?: { name?: string; geometry?: { location?: { lat: number; lng: number } } }[]
        }
        const first = nearbyData?.status === "OK" ? nearbyData?.results?.[0] : null
        if (first) placeResult = parsePlace(first, args.locationName)
        else rawErrors.push(`Nearby: status=${nearbyData?.status ?? nearbyRes.status} ${nearbyData?.error_message ?? ""}`)
      } catch (e) {
        rawErrors.push(`Nearby: ${String((e as Error)?.message ?? e)}`)
      }
    }

    // 3. Legacy Text Search with location bias
    if (!placeResult) {
      try {
        const textRes = await fetch(
          `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(keyword)}&location=${args.originLat},${args.originLng}&key=${googleKey}`
        )
        const textData = (await textRes.json()) as {
          status?: string
          error_message?: string
          results?: { name?: string; geometry?: { location?: { lat: number; lng: number } } }[]
        }
        const first = textData?.status === "OK" ? textData?.results?.[0] : null
        if (first) placeResult = parsePlace(first, args.locationName)
        else rawErrors.push(`TextSearch(loc): status=${textData?.status ?? textRes.status} ${textData?.error_message ?? ""}`)
      } catch (e) {
        rawErrors.push(`TextSearch(loc): ${String((e as Error)?.message ?? e)}`)
      }
    }

    // 4. Legacy Text Search — no location (returns prominent results)
    if (!placeResult) {
      try {
        const textRes = await fetch(
          `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(keyword)}&key=${googleKey}`
        )
        const textData = (await textRes.json()) as {
          status?: string
          error_message?: string
          results?: { name?: string; geometry?: { location?: { lat: number; lng: number } } }[]
        }
        const first = textData?.status === "OK" ? textData?.results?.[0] : null
        if (first) placeResult = parsePlace(first, args.locationName)
        else rawErrors.push(`TextSearch: status=${textData?.status ?? textRes.status} ${textData?.error_message ?? ""}`)
      } catch (e) {
        rawErrors.push(`TextSearch: ${String((e as Error)?.message ?? e)}`)
      }
    }

    // 5. Reverse geocode + Geocode "Starbucks [city], [state]"
    if (!placeResult) {
      try {
        const revRes = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?latlng=${args.originLat},${args.originLng}&key=${googleKey}`
        )
        const revData = (await revRes.json()) as {
          status?: string
          error_message?: string
          results?: { address_components?: { long_name: string; types: string[] }[] }[]
        }
        const components = revData?.results?.[0]?.address_components ?? []
        const city =
          components.find((c) => c.types.includes("locality"))?.long_name ??
          components.find((c) => c.types.includes("administrative_area_level_2"))?.long_name ??
          "San Francisco"
        const state =
          components.find((c) => c.types.includes("administrative_area_level_1"))?.long_name ?? "CA"
        const geoRes = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
            `${keyword} ${city}, ${state}`
          )}&key=${googleKey}`
        )
        const geoData = (await geoRes.json()) as {
          status?: string
          error_message?: string
          results?: { geometry?: { location?: { lat: number; lng: number } } }[]
        }
        const loc = geoData?.results?.[0]?.geometry?.location
        if (loc) placeResult = { name: keyword, lat: loc.lat, lng: loc.lng }
        else rawErrors.push(`Geocode(${keyword} ${city}): status=${geoData?.status ?? geoRes.status} ${geoData?.error_message ?? ""}`)
      } catch (e) {
        rawErrors.push(`Geocode(rev): ${String((e as Error)?.message ?? e)}`)
      }
    }

    // 6. Last resort: Geocode "keyword" with bounds around origin
    if (!placeResult) {
      try {
        const delta = 0.5
        const bounds = `${args.originLat - delta},${args.originLng - delta}|${args.originLat + delta},${args.originLng + delta}`
        const geoRes = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(keyword)}&bounds=${encodeURIComponent(bounds)}&key=${googleKey}`
        )
        const geoData = (await geoRes.json()) as {
          status?: string
          error_message?: string
          results?: { geometry?: { location?: { lat: number; lng: number } } }[]
        }
        const loc = geoData?.results?.[0]?.geometry?.location
        if (loc) placeResult = { name: keyword, lat: loc.lat, lng: loc.lng }
        else rawErrors.push(`Geocode(bounds): status=${geoData?.status ?? geoRes.status} ${geoData?.error_message ?? ""}`)
      } catch (e) {
        rawErrors.push(`Geocode(bounds): ${String((e as Error)?.message ?? e)}`)
      }
    }

    // 7. Absolute last resort: Geocode "keyword" — no bounds
    if (!placeResult) {
      try {
        const geoRes = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(keyword)}&key=${googleKey}`
        )
        const geoData = (await geoRes.json()) as {
          status?: string
          error_message?: string
          results?: { geometry?: { location?: { lat: number; lng: number } } }[]
        }
        const loc = geoData?.results?.[0]?.geometry?.location
        if (loc) placeResult = { name: keyword, lat: loc.lat, lng: loc.lng }
        else rawErrors.push(`Geocode: status=${geoData?.status ?? geoRes.status} ${geoData?.error_message ?? ""}`)
      } catch (e) {
        rawErrors.push(`Geocode: ${String((e as Error)?.message ?? e)}`)
      }
    }

    if (!placeResult) {
      const errMsg = rawErrors.length
        ? `No place found. Raw errors: ${rawErrors.join(" | ")}`
        : "No place found"
      return { error: errMsg, name: "", lat: 0, lng: 0, time_added: 0 }
    }

    const baseUrl = "https://maps.googleapis.com/maps/api/directions/json"
    const origin = `${args.originLat},${args.originLng}`
    const dest = `${args.destLat},${args.destLng}`
    const waypoint = `${placeResult.lat},${placeResult.lng}`

    const [directRes, waypointRes] = await Promise.all([
      fetch(`${baseUrl}?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&key=${googleKey}`),
      fetch(
        `${baseUrl}?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&waypoints=${encodeURIComponent(waypoint)}&key=${googleKey}`
      ),
    ])

    const directData = (await directRes.json()) as { routes?: { legs?: { duration?: { value: number } }[] }[] }
    const waypointData = (await waypointRes.json()) as { routes?: { legs?: { duration?: { value: number } }[] }[] }
    const directSec = directData?.routes?.[0]?.legs?.reduce((s, l) => s + (l.duration?.value ?? 0), 0) ?? 0
    const waypointSec = waypointData?.routes?.[0]?.legs?.reduce((s, l) => s + (l.duration?.value ?? 0), 0) ?? 0
    const timeAdded = Math.max(0, Math.ceil((waypointSec - directSec) / 60))

    return {
      name: placeResult.name,
      lat: placeResult.lat,
      lng: placeResult.lng,
      time_added: timeAdded,
    }
  },
})
