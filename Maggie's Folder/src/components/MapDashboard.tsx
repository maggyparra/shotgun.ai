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
import { AnchoredMapPopup } from "./AnchoredMapPopup"
import { CarMarkerOverlay } from "./CarMarkerOverlay"
import { LiveTranscriptionHUD } from "./LiveTranscriptionHUD"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAction, useMutation, useQuery } from "convex/react"
import { api } from "../../convex/_generated/api"
import { useAgent } from "@/context/AgentContext"
import { useNavigation } from "@/context/NavigationContext"

const mapLibraries: Libraries = ["places", "geometry"]

/** 580 20th Street, San Francisco CA — Mission District (on land, not in the bay) */
const ADDRESS_580_20TH_SF = { lat: 37.7592, lng: -122.418 }
const defaultCenter = ADDRESS_580_20TH_SF
const defaultZoom = 17
const carSimulationIntervalMsBase = 150

/** Lerp between two lat/lng points */
function lerp(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  t: number
): { lat: number; lng: number } {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }
}

/** Black navigator pin SVG (for destination) */
const NAVIGATOR_PIN_ICON = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23000" stroke="%23fff" stroke-width="1.5" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>'
)}`

/** No custom styles so map tiles (roads, labels) always show */
const mapOptionsBase: google.maps.MapOptions = {
  mapTypeId: "roadmap",
  disableDefaultUI: false,
  zoomControl: true,
  mapTypeControl: true,
  streetViewControl: false,
  fullscreenControl: true,
  clickableIcons: false, // Prevent white Google InfoWindow when clicking POIs — we use our black stained glass popup
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

/** Bearing in degrees from point A to B (0 = North, 90 = East) */
function bearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLon = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const x = Math.sin(dLon) * Math.cos(lat2)
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360
}

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

/** Memoized map content — does not re-render when only carPosition/carIndex changes during turn-by-turn */
const MapContent = React.memo(function MapContent({
  pathForPolyline,
  mapOptions,
  mapCenter,
  selectedDestination,
  userLocation,
  destination,
  stops,
  isGoMode,
  smoothPosRef,
  onLoad,
  onUnmount,
  onClick,
}: {
  pathForPolyline: { lat: number; lng: number }[]
  mapOptions: google.maps.MapOptions
  mapCenter: { lat: number; lng: number }
  selectedDestination: { lat: number; lng: number; address: string; durationMinutes: number; steps: string[] } | null
  userLocation: { lat: number; lng: number; accuracy?: number } | null
  destination: { lat: number; lng: number } | null
  stops: { _id: string; label: string; lat: number; lng: number }[]
  isGoMode: boolean
  smoothPosRef: React.MutableRefObject<{ lat: number; lng: number } | null>
  onLoad: (map: google.maps.Map) => void
  onUnmount: () => void
  onClick: (e: google.maps.MapMouseEvent) => void
}) {
  return (
    <GoogleMap
      mapContainerStyle={{ width: "100%", height: "100vh" }}
      center={mapCenter}
      zoom={defaultZoom}
      onLoad={onLoad}
      onUnmount={onUnmount}
      onClick={onClick}
      options={mapOptions}
    >
      {selectedDestination && (
        <>
          <AnchoredMapPopup
            position={{ lat: selectedDestination.lat, lng: selectedDestination.lng }}
            address={selectedDestination.address}
            googleMapsUrl={`https://www.google.com/maps/dir/?api=1&destination=${selectedDestination.lat},${selectedDestination.lng}`}
          />
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
        </>
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
        <>
          <Polyline
            path={pathForPolyline}
            options={{
              strokeColor: "#349DFE",
              strokeOpacity: 1,
              strokeWeight: 12,
            }}
          />
          <Polyline
            path={pathForPolyline}
            options={{
              strokeColor: "#0472F2",
              strokeOpacity: 1,
              strokeWeight: 8,
            }}
          />
        </>
      )}
      {isGoMode && <CarMarkerOverlay positionRef={smoothPosRef} visible />}
      {destination && (
        <Marker
          position={destination}
          title="Destination"
          icon={{
            url: NAVIGATOR_PIN_ICON,
            scaledSize: new google.maps.Size(40, 40),
            anchor: new google.maps.Point(20, 40),
          }}
        />
      )}
      {stops.map((stop) => (
        <Marker
          key={stop._id}
          position={{ lat: stop.lat, lng: stop.lng }}
          title={stop.label}
          icon={{
            url: NAVIGATOR_PIN_ICON,
            scaledSize: new google.maps.Size(32, 32),
            anchor: new google.maps.Point(16, 32),
          }}
        />
      ))}
    </GoogleMap>
  )
})

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
  const { status: agentStatus, agentResponse, pendingProposal, setStatus, setPendingProposal, setAgentResponse, setError, clearProposal } = useAgent()
  const proposeStopAction = useAction(api.agent.proposeStop as Parameters<typeof useAction>[0])
  const addStopMutation = useMutation(api.stops.addStop as Parameters<typeof useMutation>[0])
  const removeStopMutation = useMutation(api.stops.removeStop as Parameters<typeof useMutation>[0])
  const lastTriggeredPlaceRef = useRef<string>("")
  const arrivedAtStopIds = useRef<Set<string>>(new Set())
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
    replayNavigation,
    setPath,
    setPathPreservingPosition,
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
  const [simulationSpeed, setSimulationSpeed] = useState(0.1) // 0.1, 0.25, 0.5, 1, 2
  const [isCalculatingReroute, setIsCalculatingReroute] = useState(false)
  const smoothPosRef = useRef<{ lat: number; lng: number } | null>(null)
  const rafRef = useRef<number | null>(null)
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

  // Request microphone permission on init (for live transcription HUD)
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return
    navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
      // User may deny; we'll show error in HUD when they try to use it
    })
  }, [])

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

  // Reset tilt/heading when exiting turn-by-turn
  const mapRef = useRef<google.maps.Map | null>(null)
  mapRef.current = map
  useEffect(() => {
    if (!map || isGoMode) return
    try {
      if (typeof map.setTilt === "function") map.setTilt(0)
      if (typeof map.setHeading === "function") map.setHeading(0)
    } catch {
      // ignore
    }
  }, [map, isGoMode])

  const tickIntervalMs = Math.round(carSimulationIntervalMsBase / simulationSpeed)

  useEffect(() => {
    if (!isGoMode || path.length === 0 || isSimulationPaused) {
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
      return
    }
    tickRef.current = setInterval(tickCar, tickIntervalMs)
    return () => {
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [isGoMode, path.length, tickCar, isSimulationPaused, tickIntervalMs])

  // When stops are added: request OPTIMIZED route (shortest) from current position → stops → destination
  const prevStopsLen = useRef(0)
  useEffect(() => {
    if (!isGoMode || path.length === 0 || !destination || stops.length <= prevStopsLen.current) {
      prevStopsLen.current = stops.length
      return
    }
    const oldLen = prevStopsLen.current
    prevStopsLen.current = stops.length
    const newStops = stops.slice(oldLen)
    if (newStops.length === 0) return

    setIsCalculatingReroute(true)
    if (typeof google === "undefined" || !google.maps?.DirectionsService) {
      setIsCalculatingReroute(false)
      return
    }
    const origin = carPosition ?? path[carIndex] ?? path[0]
    const waypoints = stops.map((s) => ({ location: new google.maps.LatLng(s.lat, s.lng), stopover: true }))
    const ds = new google.maps.DirectionsService()
    ds.route(
      {
        origin: new google.maps.LatLng(origin.lat, origin.lng),
        destination: new google.maps.LatLng(destination.lat, destination.lng),
        waypoints,
        optimizeWaypoints: waypoints.length > 1,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (result, status) => {
        setIsCalculatingReroute(false)
        if (status === "OK" && result?.routes?.[0]?.overview_path?.length) {
          const pathLatLng = result.routes[0].overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() }))
          setPathPreservingPosition(pathLatLng)
        }
      }
    )
  }, [isGoMode, path, destination, stops, carPosition, carIndex, setPathPreservingPosition])

  // When car reaches a stop: pause, wait, remove stop, reroute to destination
  const ARRIVAL_THRESHOLD_M = 80
  const PAUSE_AT_STOP_MS = 2000
  useEffect(() => {
    if (!isGoMode || !carPosition || !destination || stops.length === 0) return
    const pos = carPosition
    for (const stop of stops) {
      if (arrivedAtStopIds.current.has(stop._id)) continue
      if (distanceMeters(pos, { lat: stop.lat, lng: stop.lng }) > ARRIVAL_THRESHOLD_M) continue
      arrivedAtStopIds.current.add(stop._id)
      setIsSimulationPaused(true)
      setAgentResponse(`Stopped at ${stop.label}. Rerouting to destination…`)
      const stopPos = { lat: stop.lat, lng: stop.lng }
      const timer = setTimeout(() => {
        removeStopMutation({ id: stop._id })
        if (typeof google === "undefined" || !google.maps?.DirectionsService) {
          setIsSimulationPaused(false)
          setAgentResponse(null)
          return
        }
        const ds = new google.maps.DirectionsService()
        ds.route(
          {
            origin: new google.maps.LatLng(stopPos.lat, stopPos.lng),
            destination: new google.maps.LatLng(destination.lat, destination.lng),
            travelMode: google.maps.TravelMode.DRIVING,
          },
          (result, status) => {
            setIsSimulationPaused(false)
            setAgentResponse(null)
            if (status === "OK" && result?.routes?.[0]?.overview_path?.length) {
              const newPath = result.routes[0].overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() }))
              setPath(newPath)
            }
          }
        )
      }, PAUSE_AT_STOP_MS)
      return () => clearTimeout(timer)
    }
  }, [isGoMode, carPosition, destination, stops, removeStopMutation, setPath, setAgentResponse])

  // Smooth interpolation: animate over full tick interval so car moves at constant rate (no bursts)
  useEffect(() => {
    if (!isGoMode || !carPosition) {
      smoothPosRef.current = carPosition
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      return
    }
    const target = carPosition
    const startPos = smoothPosRef.current ?? target
    const durationMs = tickIntervalMs
    let start: number | null = null
    const animate = (t: number) => {
      if (!start) start = t
      const elapsed = t - start
      const blend = Math.min(1, elapsed / durationMs)
      const next = lerp(startPos, target, blend)
      smoothPosRef.current = next
      if (blend < 1) rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [isGoMode, carPosition?.lat, carPosition?.lng, tickIntervalMs])

  // Camera locks to car: center follows smoothPosRef so car stays in middle of screen at all times
  const destRef = useRef<{ lat: number; lng: number } | null>(null)
  destRef.current = destination
  const cameraRafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!map || !isGoMode || !destination) {
      if (cameraRafRef.current) cancelAnimationFrame(cameraRafRef.current)
      return
    }
    const animate = () => {
      const pos = smoothPosRef.current
      const dest = destRef.current
      if (!pos || !dest || !map) return
      const bearing = bearingDeg(pos, dest)
      try {
        map.setCenter(pos)
        if (typeof map.setHeading === "function") map.setHeading(bearing)
        if (typeof map.setTilt === "function") map.setTilt(45)
      } catch {
        // Raster maps may not support tilt/heading
      }
      cameraRafRef.current = requestAnimationFrame(animate)
    }
    cameraRafRef.current = requestAnimationFrame(animate)
    return () => {
      if (cameraRafRef.current) cancelAnimationFrame(cameraRafRef.current)
    }
  }, [map, isGoMode, destination?.lat, destination?.lng])

  // Memoize so map doesn't re-render when only carPosition/carIndex changes (path is stable during drive)
  const pathForPolyline = useMemo(() => path.map((p) => ({ lat: p.lat, lng: p.lng })), [path])
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAP_ID
  const mapOptions = useMemo<google.maps.MapOptions>(
    () => ({
      ...mapOptionsBase,
      center: mapCenter,
      ...(mapId ? { mapId } : {}),
    }),
    [mapCenter, mapId]
  )

  const handleMapClick = useCallback(
    (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return
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
    },
    [userLocation]
  )

  const handleTranscriptUpdate = useCallback(
    (fullTranscript: string, newChunk: string) => {
      const t = fullTranscript.toLowerCase().trim()
      const c = newChunk.toLowerCase().trim()

      if (pendingProposal) {
        const yesMatch = /\b(yes|yeah|yep|yup|sure|ok|okay|add it|do it)\b/i
        const noMatch = /\b(no|nope|nah|cancel|nevermind|stick to)\b/i
        if (yesMatch.test(c) || yesMatch.test(t)) {
          addStopMutation({ label: pendingProposal.name, lat: pendingProposal.lat, lng: pendingProposal.lng })
          setAgentResponse("Added. WE are updating the route.")
          lastTriggeredPlaceRef.current = ""
          clearProposal()
        } else if (noMatch.test(c) || noMatch.test(t)) {
          setAgentResponse("Understood. Say 'add a stop to [place]' to try a different stop.")
          setStatus("idle")
          setPendingProposal(null)
          setError(null)
          lastTriggeredPlaceRef.current = ""
        }
        return
      }

      const addStopMatch = t.match(/add\s+(?:a\s+)?stop\s+(?:to|at)\s+([^.]+?)(?:\s*\.|$)/i) ?? c.match(/add\s+(?:a\s+)?stop\s+(?:to|at)\s+([^.]+?)(?:\s*\.|$)/i)
      if (addStopMatch) {
        let place = addStopMatch[1].trim()
        const words = place.split(/\s+/)
        const cutIdx = words.findIndex((w) => /^(i|we|just|got|want|need|please|and)$/i.test(w))
        if (cutIdx > 0) place = words.slice(0, cutIdx).join(" ").trim()
        if (!place) return
        if (lastTriggeredPlaceRef.current === place.toLowerCase()) return
        lastTriggeredPlaceRef.current = place.toLowerCase()
        setTimeout(() => { lastTriggeredPlaceRef.current = "" }, 8000)
        setStatus("searching")
        const origin = carPosition ?? path[0] ?? defaultCenter
        const dest = destination ?? (path[path.length - 1] ?? defaultCenter)
        proposeStopAction({
          locationName: place,
          originLat: origin.lat,
          originLng: origin.lng,
          destLat: dest.lat,
          destLng: dest.lng,
        })
          .then((r) => {
            setStatus("confirming")
            if (r.error) {
              setError(r.error)
              setAgentResponse(r.error)
            } else {
              setPendingProposal({ name: r.name, lat: r.lat, lng: r.lng, time_added: r.time_added })
              setAgentResponse(`WE found ${r.name}. It adds ${r.time_added} minutes. Should WE add it?`)
            }
          })
          .catch((e) => {
            setStatus("error")
            const msg = e?.message ?? String(e)
            setError(msg)
            const isDev = typeof process !== "undefined" && process.env?.NODE_ENV === "development"
            if (isDev && msg) {
              setAgentResponse(`Error: ${msg.slice(0, 120)}${msg.length > 120 ? "…" : ""}`)
            } else {
              setAgentResponse(
                "Something went wrong. Run Convex from Maggie's Folder (npx convex dev) and add GOOGLE_MAPS_API_KEY in Convex dashboard."
              )
            }
          })
      }
    },
    [pendingProposal, carPosition, path, destination, proposeStopAction, addStopMutation, setStatus, setPendingProposal, setAgentResponse, setError, clearProposal]
  )

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
        <MapContent
          pathForPolyline={pathForPolyline}
          mapOptions={mapOptions}
          mapCenter={mapCenter}
          selectedDestination={selectedDestination}
          userLocation={userLocation}
          destination={destination}
          stops={stops}
          isGoMode={isGoMode}
          smoothPosRef={smoothPosRef}
          onLoad={onLoad}
          onUnmount={onUnmount}
          onClick={handleMapClick}
        />
      </div>

      {selectedDestination && !isGoMode && (
        <>
          {/* Black stained glass popup is rendered by AnchoredMapPopup inside GoogleMap — anchored to the clicked location */}
          {/* Light gray glass tab bar at bottom */}
          <div className="absolute bottom-4 left-4 right-4 z-10 max-h-[38vh] overflow-y-auto rounded-2xl border border-zinc-300/50 bg-zinc-200/60 px-4 py-3 shadow-[0_-8px_40px_rgba(0,0,0,0.12)] backdrop-blur-2xl backdrop-saturate-150">
            <p className="text-2xl font-bold leading-tight text-zinc-900">{selectedDestination.address}</p>
            <p className="mt-1 text-xl font-medium text-zinc-600">
              {selectedDestination.durationMinutes > 0
                ? `~${selectedDestination.durationMinutes} min`
                : "Getting route…"}
            </p>
            {selectedDestination.steps.length > 0 && (
              <div className="mt-3 pt-3 border-t border-zinc-300/60">
                <p className="mb-1.5 text-lg font-bold uppercase tracking-wider text-zinc-600">Summary of turns</p>
                <ol className="space-y-1.5 text-xl text-zinc-800">
                  {selectedDestination.steps.slice(0, 3).map((step, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 font-bold text-zinc-500">{i + 1}.</span>
                      <span>{step}</span>
                    </li>
                  ))}
                  {selectedDestination.steps.length > 3 && (
                    <li className="text-lg text-zinc-500">+{selectedDestination.steps.length - 3} more</li>
                  )}
                </ol>
              </div>
            )}
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${selectedDestination.lat},${selectedDestination.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-16 items-center justify-center rounded-2xl border-2 border-zinc-400/80 bg-white/80 px-6 text-xl font-bold text-zinc-800 transition hover:bg-white active:scale-[0.98]"
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
              className="h-16 shrink-0 rounded-2xl bg-blue-500 px-10 text-2xl font-bold text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-400 active:scale-[0.98]"
            >
              Go
            </button>
          </div>
        </div>
        </>
      )}

      {isCalculatingReroute && (
        <div className="absolute left-1/2 top-24 z-30 -translate-x-1/2 rounded-2xl border-2 border-sky-400/60 bg-white/50 px-6 py-3 shadow-xl backdrop-blur-xl">
          <p className="text-lg font-semibold text-zinc-800">Calculating Reroute…</p>
        </div>
      )}
      {isGoMode && path.length > 0 && (
        <>
          <LiveTranscriptionHUD
            active={isGoMode && !isSimulationPaused && carIndex < path.length - 1}
            agentStatus={agentStatus}
            agentResponse={agentResponse}
            onTranscriptUpdate={handleTranscriptUpdate}
            onConfirmStop={
              pendingProposal
                ? () => {
                    addStopMutation({ label: pendingProposal!.name, lat: pendingProposal!.lat, lng: pendingProposal!.lng })
                    setAgentResponse("Added. WE are updating the route.")
                    lastTriggeredPlaceRef.current = ""
                    clearProposal()
                  }
                : undefined
            }
            onCancelStop={
              pendingProposal
                ? () => {
                    setAgentResponse("Understood. Say 'add a stop to [place]' to try a different stop.")
                    setStatus("idle")
                    setPendingProposal(null)
                    setError(null)
                    lastTriggeredPlaceRef.current = ""
                  }
                : undefined
            }
          />
          <div className="absolute left-4 right-4 top-4 z-10 flex items-center gap-4 rounded-2xl border border-white/30 bg-white/40 px-6 py-4 text-zinc-900 shadow-lg backdrop-blur-2xl backdrop-saturate-150">
            <span className="text-4xl" aria-hidden>
              ↗
            </span>
            <div className="flex flex-1 flex-col">
              <span className="text-2xl font-bold text-zinc-900">
                {carIndex >= path.length - 1
                  ? "You have arrived"
                  : `${Math.round(remainingPathDistance(path, carIndex))} m`}
              </span>
              <span className="text-xl text-zinc-600">
                {carIndex >= path.length - 1
                  ? destinationName ?? "Destination"
                  : "Head toward " + (destinationName ?? "destination")}
              </span>
            </div>
          </div>
          <div className="absolute bottom-4 left-4 right-4 z-10 flex items-center justify-between gap-5 rounded-3xl border border-white/30 bg-white/40 px-6 py-5 shadow-[0_-8px_40px_rgba(0,0,0,0.08)] backdrop-blur-2xl backdrop-saturate-150">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setIsSimulationPaused(false)
                  stopGoMode()
                }}
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white/50 text-zinc-700 transition hover:bg-white/70 active:scale-95 backdrop-blur-xl"
                aria-label="End navigation"
              >
                <span className="text-3xl font-bold">×</span>
              </button>
              <button
                type="button"
                onClick={() => setIsSimulationPaused((p) => !p)}
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white/50 text-zinc-700 transition hover:bg-white/70 active:scale-95 backdrop-blur-xl"
                aria-label={isSimulationPaused ? "Resume" : "Pause"}
              >
                {isSimulationPaused ? (
                  <span className="text-2xl" aria-hidden>▶</span>
                ) : (
                  <span className="text-2xl" aria-hidden>⏸</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  arrivedAtStopIds.current.clear()
                  replayNavigation()
                  setIsSimulationPaused(false)
                }}
                className="flex h-16 shrink-0 items-center gap-2.5 rounded-2xl bg-white/50 px-5 py-3 text-xl font-bold text-zinc-700 transition hover:bg-white/70 active:scale-95 backdrop-blur-xl"
                aria-label="Replay trip"
              >
                <span aria-hidden>↻</span>
                Replay
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-2xl bg-white/50 px-4 py-2.5 backdrop-blur-xl">
              <span className="text-xl font-bold text-zinc-600">Speed</span>
              {([0.1, 0.25, 0.5, 1, 2] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSimulationSpeed(s)}
                  className={`rounded-xl px-4 py-2 text-lg font-bold transition ${
                    simulationSpeed === s
                      ? "bg-zinc-800/30 text-zinc-900"
                      : "text-zinc-600 hover:bg-white/60"
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-2xl font-bold text-zinc-900">
                {carIndex >= path.length - 1
                  ? "You have arrived"
                  : "Head toward " + (destinationName ?? "destination")}
              </p>
              <p className="mt-1 text-xl text-zinc-500">
                {carIndex >= path.length - 1
                  ? destinationName ?? "Destination"
                  : `${(remainingPathDistance(path, carIndex) / 1000).toFixed(1)} km • ~${Math.max(0, Math.ceil((remainingPathDistance(path, carIndex) / 1000) * 2))} min`}
              </p>
            </div>
          </div>
        </>
      )}

      {userLocationError && !isGoMode && (
        <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-2xl border border-white/30 bg-white/40 px-4 py-3 text-[13px] text-zinc-600 shadow-lg backdrop-blur-2xl backdrop-saturate-150">
          Location unavailable. Enable location access to see your position.
        </div>
      )}
      {!isGoMode && !selectedDestination && (
        <div className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-2xl border border-white/30 bg-white/40 px-5 py-3 text-[14px] text-zinc-600 shadow-lg backdrop-blur-2xl backdrop-saturate-150">
          Click the map to drop a pin and get directions
        </div>
      )}
    </div>
  )
}
