"use client"

/**
 * Main Map Dashboard — full-screen dark map, route polyline, car marker, Convex stops.
 * GO mode: car moves along decoded polyline at a constant rate (simulated driving).
 */

import {
  GoogleMap,
  useJsApiLoader,
  Marker,
  Polyline,
  Circle,
  type Libraries,
} from "@react-google-maps/api"
import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery } from "convex/react"
import { api } from "../../convex/_generated/api"
import { useNavigation } from "@/context/NavigationContext"

const mapLibraries: Libraries = ["places", "geometry"]

/** 580 20th Street, San Francisco CA — Mission District (on land, not in the bay) */
const ADDRESS_580_20TH_SF = { lat: 37.7592, lng: -122.418 }
const defaultCenter = ADDRESS_580_20TH_SF
const defaultZoom = 17
const carSimulationIntervalMs = 150

/** No custom styles so map tiles (roads, labels) always show */
const mapOptionsBase: google.maps.MapOptions = {
  mapTypeId: "roadmap",
  disableDefaultUI: false,
  zoomControl: true,
  mapTypeControl: true,
  streetViewControl: false,
  fullscreenControl: true,
  tilt: 0,
  zoom: defaultZoom,
}

/** Demo path: 580 20th St SF (Mission) → northwest along streets so route stays on land */
const DEMO_PATH: { lat: number; lng: number }[] = [
  { lat: 37.7592, lng: -122.418 },
  { lat: 37.7605, lng: -122.417 },
  { lat: 37.7618, lng: -122.416 },
  { lat: 37.763, lng: -122.415 },
  { lat: 37.7642, lng: -122.414 },
  { lat: 37.7655, lng: -122.413 },
  { lat: 37.7668, lng: -122.412 },
  { lat: 37.768, lng: -122.411 },
  { lat: 37.7692, lng: -122.41 },
  { lat: 37.7705, lng: -122.409 },
  { lat: 37.7718, lng: -122.408 },
]

/** Approximate distance in meters between two lat/lng points (Haversine) */
function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
  return R * c
}

/** Strip HTML tags from Google Directions instructions */
function stripHtml(html: string): string {
  if (typeof document === "undefined") {
    return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ")
  }
  const div = document.createElement("div")
  div.innerHTML = html
  return div.textContent?.trim() ?? html.replace(/<[^>]*>/g, "")
}

/** Total remaining distance along path from index to end, in meters */
function remainingPathDistance(
  path: { lat: number; lng: number }[],
  fromIndex: number
): number {
  if (fromIndex >= path.length - 1) return 0
  let d = 0
  for (let i = fromIndex; i < path.length - 1; i++) {
    d += distanceMeters(path[i], path[i + 1])
  }
  return d
}

export function MapDashboard() {
  const [mapReady, setMapReady] = useState(false)
  const { isLoaded, loadError } = useJsApiLoader({
    id: "shotgun-google-map",
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
    libraries: mapLibraries,
    version: "quarterly",
  })
  type StopDoc = { _id: string; label: string; lat: number; lng: number }
  const stops: StopDoc[] = (useQuery((api as { stops: { listStops: unknown } }).stops.listStops as Parameters<typeof useQuery>[0]) ?? []) as StopDoc[]
  const {
    path,
    carPosition,
    carIndex,
    isGoMode,
    destination,
    startNavigationWithPath,
    stopGoMode,
    destinationName,
    tickCar,
  } = useNavigation()
  const [map, setMap] = useState<google.maps.Map | null>(null)
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number }>(defaultCenter)
  const [selectedDestination, setSelectedDestination] = useState<{
    lat: number
    lng: number
    address: string
    durationMinutes: number
    steps: string[]
  } | null>(null)
  const [isSimulationPaused, setIsSimulationPaused] = useState(false)
  const [userLocation, setUserLocation] = useState<{
    lat: number
    lng: number
    accuracy?: number
  } | null>(null)
  const [userLocationError, setUserLocationError] = useState<string | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const dragListenerRef = useRef<google.maps.MapsEventListener | null>(null)

  useEffect(() => {
    if (!isLoaded) return
    const t = setTimeout(() => setMapReady(true), 150)
    return () => clearTimeout(t)
  }, [isLoaded])

  useEffect(() => {
    if (!mapReady || typeof navigator === "undefined" || !navigator.geolocation) return
    setUserLocationError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords
        setUserLocation({ lat: latitude, lng: longitude, accuracy: accuracy ?? 50 })
        setMapCenter({ lat: latitude, lng: longitude })
      },
      (err) => {
        setUserLocationError(err.message)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }, [mapReady])

  const onLoad = useCallback((mapInstance: google.maps.Map) => {
    setMap(mapInstance)
    mapInstance.setCenter(defaultCenter)
    mapInstance.setZoom(defaultZoom)
    if (typeof google !== "undefined" && google.maps?.event) {
      google.maps.event.trigger(mapInstance, "resize")
    }
    mapInstance.setCenter(defaultCenter)
    mapInstance.setZoom(defaultZoom)
    dragListenerRef.current = google.maps.event.addListener(mapInstance, "dragend", () => {
      const c = mapInstance.getCenter()
      if (c) setMapCenter({ lat: c.lat(), lng: c.lng() })
    })
    setTimeout(() => {
      if (typeof google !== "undefined" && google.maps?.event) {
        google.maps.event.trigger(mapInstance, "resize")
      }
      mapInstance.setCenter(defaultCenter)
      mapInstance.setZoom(defaultZoom)
    }, 400)
  }, [])

  const onUnmount = useCallback(() => {
    if (dragListenerRef.current && typeof google !== "undefined" && google.maps?.event) {
      google.maps.event.removeListener(dragListenerRef.current)
      dragListenerRef.current = null
    }
    setMap(null)
  }, [])

  useEffect(() => {
    if (!isGoMode || path.length === 0 || isSimulationPaused) {
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
      return
    }
    tickRef.current = setInterval(tickCar, carSimulationIntervalMs)
    return () => {
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [isGoMode, path.length, tickCar, isSimulationPaused])

  const pathForPolyline = path.map((p) => ({ lat: p.lat, lng: p.lng }))
  const mapOptions: google.maps.MapOptions = {
    ...mapOptionsBase,
    center: mapCenter,
  }

  if (loadError) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-zinc-950 text-red-400">
        WE could not load the map. Check your Google Maps API key.
      </div>
    )
  }

  if (!isLoaded) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-zinc-950 text-zinc-400">
        Loading map…
      </div>
    )
  }

  if (!mapReady) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-zinc-950 text-zinc-400">
        Preparing map…
      </div>
    )
  }

  return (
    <div className="relative w-full bg-zinc-950" style={{ height: "100vh", minHeight: 400 }}>
      <div className="absolute inset-0 w-full" style={{ height: "100vh" }}>
        <GoogleMap
          mapContainerStyle={{ width: "100%", height: "100vh" }}
          center={mapCenter}
          zoom={defaultZoom}
          onLoad={onLoad}
          onUnmount={onUnmount}
          onClick={(e) => {
            if (e.latLng) {
              const lat = e.latLng.lat()
              const lng = e.latLng.lng()
              const origin = userLocation ?? defaultCenter
              const updateAddress = (addr: string) => {
                setSelectedDestination((prev) =>
                  prev && prev.lat === lat && prev.lng === lng ? { ...prev, address: addr } : prev
                )
              }
              const updateDuration = (mins: number) => {
                setSelectedDestination((prev) =>
                  prev && prev.lat === lat && prev.lng === lng ? { ...prev, durationMinutes: mins } : prev
                )
              }
              const updateSteps = (steps: string[]) => {
                setSelectedDestination((prev) =>
                  prev && prev.lat === lat && prev.lng === lng ? { ...prev, steps } : prev
                )
              }
              setSelectedDestination({
                lat,
                lng,
                address: "…",
                durationMinutes: 0,
                steps: [],
              })
              if (typeof google !== "undefined" && google.maps?.Geocoder) {
                const g = new google.maps.Geocoder()
                g.geocode({ location: { lat, lng } }, (results, status) => {
                  if (status === "OK" && results?.[0]) {
                    updateAddress(results[0].formatted_address)
                  } else {
                    updateAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)}`)
                  }
                })
              } else {
                updateAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)}`)
              }
              if (typeof google !== "undefined" && google.maps?.DirectionsService) {
                const ds = new google.maps.DirectionsService()
                ds.route(
                  {
                    origin: new google.maps.LatLng(origin.lat, origin.lng),
                    destination: new google.maps.LatLng(lat, lng),
                    travelMode: google.maps.TravelMode.DRIVING,
                  },
                  (result, status) => {
                    if (status === "OK" && result?.routes?.[0]?.legs?.[0]) {
                      const leg = result.routes[0].legs[0]
                      if (leg.duration?.value) {
                        updateDuration(Math.ceil(leg.duration.value / 60))
                      }
                      const steps = (leg.steps ?? [])
                        .map((s) => (s.instructions ? stripHtml(s.instructions) : ""))
                        .filter(Boolean)
                      updateSteps(steps)
                    }
                  }
                )
              }
            }
          }}
          options={mapOptions}
        >
        {selectedDestination && (
          <Marker
            position={{ lat: selectedDestination.lat, lng: selectedDestination.lng }}
            title={selectedDestination.address}
            icon={{
              url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23ea4335" stroke="%23fff" stroke-width="1.5" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>'
              )}`,
              scaledSize: new google.maps.Size(40, 40),
              anchor: new google.maps.Point(20, 40),
            }}
          />
        )}
        {userLocation && (
          <>
            <Circle
              center={userLocation}
              radius={userLocation.accuracy ?? 50}
              options={{
                fillColor: "#5ac8fa",
                fillOpacity: 0.2,
                strokeColor: "#5ac8fa",
                strokeOpacity: 0.5,
                strokeWeight: 1,
                clickable: false,
              }}
            />
            <Marker
              position={userLocation}
              title="Your location"
              icon={{
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: "#007AFF",
                fillOpacity: 1,
                strokeColor: "#ffffff",
                strokeWeight: 2,
              }}
            />
          </>
        )}
        {pathForPolyline.length > 0 && (
          <Polyline
            path={pathForPolyline}
            options={{
              strokeColor: "#22d3ee",
              strokeOpacity: 0.9,
              strokeWeight: 5,
            }}
          />
        )}
        {isGoMode && (
        <Marker
          position={carPosition ?? defaultCenter}
          title="Your simulated location"
          icon={{
            path: google.maps.SymbolPath.CIRCLE,
            scale: 12,
            fillColor: "#facc15",
            fillOpacity: 1,
            strokeColor: "#1e293b",
            strokeWeight: 2,
          }}
        />
        )}
        {destination && (
          <Marker
            position={destination}
            title="Destination"
            icon={{
              path: google.maps.SymbolPath.CIRCLE,
              scale: 10,
              fillColor: "#22c55e",
              fillOpacity: 1,
              strokeColor: "#1e293b",
              strokeWeight: 2,
            }}
          />
        )}
        {stops.map((stop) => (
          <Marker
            key={stop._id}
            position={{ lat: stop.lat, lng: stop.lng }}
            title={stop.label}
            icon={{
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: "#a78bfa",
              fillOpacity: 1,
              strokeColor: "#1e293b",
              strokeWeight: 2,
            }}
          />
        ))}
      </GoogleMap>
      </div>

      {selectedDestination && !isGoMode && (
        <div className="absolute bottom-0 left-0 right-0 z-10 max-h-[50vh] overflow-y-auto rounded-t-2xl border border-zinc-200 bg-white px-4 py-4 shadow-[0_-4px_20px_rgba(0,0,0,0.15)]">
          <p className="font-semibold text-zinc-900">{selectedDestination.address}</p>
          <p className="mt-0.5 text-sm text-zinc-500">
            {selectedDestination.durationMinutes > 0
              ? `~${selectedDestination.durationMinutes} min`
              : "Getting route…"}
          </p>
          {selectedDestination.steps.length > 0 && (
            <div className="mt-3 border-t border-zinc-100 pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Summary of turns</p>
              <ol className="space-y-1.5 text-sm text-zinc-700">
                {selectedDestination.steps.slice(0, 6).map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 font-medium text-zinc-400">{i + 1}.</span>
                    <span>{step}</span>
                  </li>
                ))}
                {selectedDestination.steps.length > 6 && (
                  <li className="text-zinc-400">+{selectedDestination.steps.length - 6} more</li>
                )}
              </ol>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${selectedDestination.lat},${selectedDestination.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline"
            >
              View on Google Maps
            </a>
            <button
              type="button"
              onClick={() => {
                const origin = userLocation ?? defaultCenter
                const dest = { lat: selectedDestination.lat, lng: selectedDestination.lng }
                const destName = selectedDestination.address
                if (typeof google !== "undefined" && google.maps?.DirectionsService) {
                  const ds = new google.maps.DirectionsService()
                  ds.route(
                    {
                      origin: new google.maps.LatLng(origin.lat, origin.lng),
                      destination: new google.maps.LatLng(dest.lat, dest.lng),
                      travelMode: google.maps.TravelMode.DRIVING,
                    },
                    (result, status) => {
                      if (status === "OK" && result?.routes?.[0]?.overview_path?.length) {
                        const pathLatLng = result.routes[0].overview_path.map((p) => ({
                          lat: p.lat(),
                          lng: p.lng(),
                        }))
                        setIsSimulationPaused(false)
                        startNavigationWithPath(pathLatLng, destName)
                      } else {
                        setIsSimulationPaused(false)
                        startNavigationWithPath([origin, dest], destName)
                      }
                      setSelectedDestination(null)
                    }
                  )
                } else {
                  setIsSimulationPaused(false)
                  startNavigationWithPath([origin, dest], destName)
                  setSelectedDestination(null)
                }
              }}
              className="rounded-xl bg-blue-600 px-5 py-2.5 font-medium text-white transition hover:bg-blue-500"
            >
              Go
            </button>
          </div>
        </div>
      )}

      {isGoMode && path.length > 0 && (
        <>
          <div className="absolute left-0 right-0 top-0 z-10 flex items-center gap-3 bg-blue-600 px-4 py-3 text-white shadow-lg">
            <span className="text-2xl" aria-hidden>
              ↗
            </span>
            <div className="flex flex-1 flex-col">
              <span className="text-lg font-semibold">
                {carIndex >= path.length - 1
                  ? "You have arrived"
                  : `${Math.round(remainingPathDistance(path, carIndex))} m`}
              </span>
              <span className="text-sm opacity-90">
                {carIndex >= path.length - 1
                  ? destinationName ?? "Destination"
                  : "Head toward " + (destinationName ?? "destination")}
              </span>
            </div>
          </div>
          <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center justify-between gap-4 rounded-t-2xl border-t border-zinc-200 bg-white px-4 py-4 shadow-[0_-4px_20px_rgba(0,0,0,0.15)] dark:border-zinc-700 dark:bg-zinc-900">
            <button
              type="button"
              onClick={() => {
                setIsSimulationPaused(false)
                stopGoMode()
              }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600"
              aria-label="End navigation"
            >
              <span className="text-xl font-bold">×</span>
            </button>
            <button
              type="button"
              onClick={() => setIsSimulationPaused((p) => !p)}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600"
              aria-label={isSimulationPaused ? "Resume" : "Pause"}
            >
              {isSimulationPaused ? (
                <span className="text-lg" aria-hidden>▶</span>
              ) : (
                <span className="text-lg" aria-hidden>⏸</span>
              )}
            </button>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                {carIndex >= path.length - 1
                  ? "You have arrived"
                  : "Head toward " + (destinationName ?? "destination")}
              </p>
              <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
                {carIndex >= path.length - 1
                  ? destinationName ?? "Destination"
                  : `${(remainingPathDistance(path, carIndex) / 1000).toFixed(1)} km • ${Math.max(0, Math.ceil((remainingPathDistance(path, carIndex) / 1000) * 2))} min`}
              </p>
            </div>
          </div>
        </>
      )}

      {userLocationError && !isGoMode && (
        <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-lg border border-zinc-600 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-400 backdrop-blur">
          Location unavailable. Enable location access to see your position.
        </div>
      )}
      {!isGoMode && !selectedDestination && (
        <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-500 backdrop-blur">
          Click the map to drop a pin and get directions
        </div>
      )}
    </div>
  )
}
