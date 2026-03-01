"use client"

/**
 * Map Dashboard — Maggie's Google Maps + Convex, with John's:
 * - Slow simulation (1200ms per step)
 * - Map zooms/follows current location (zoom 17)
 * - Turn-by-turn banner at top: next instruction + distance to that turn
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
import type { Id } from "../../convex/_generated/dataModel"
import { useNavigation, type RouteStep } from "@/context/NavigationContext"
import { snapToPath } from "@/lib/pathUtils"
import type { CopilotContext } from "@/lib/copilot-types"
import { VoiceCopilot } from "@/components/VoiceCopilot"

const mapLibraries: Libraries = ["places", "geometry"]
const defaultCenter = { lat: 37.7592, lng: -122.418 }
const FOLLOW_ZOOM = 17
/** Even slower simulation so you can read each step (~2.5s per point) */
const SIMULATION_INTERVAL_MS = 2500
const SEARCH_BAR_HEIGHT = 48

const mapOptionsBase: google.maps.MapOptions = {
  mapTypeId: "roadmap",
  disableDefaultUI: false,
  zoomControl: true,
  mapTypeControl: true,
  streetViewControl: false,
  fullscreenControl: true,
  tilt: 0,
  zoom: FOLLOW_ZOOM,
}

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

/** Bearing in degrees from point a to b (0 = north, 90 = east) */
function bearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (x: number) => (x * Math.PI) / 180
  const dLng = toRad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat))
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function pathSegmentDistance(
  path: { lat: number; lng: number }[],
  fromIndex: number,
  toIndex: number
): number {
  if (fromIndex >= toIndex || fromIndex < 0 || toIndex > path.length) return 0
  let d = 0
  for (let i = fromIndex; i < toIndex && i < path.length - 1; i++) {
    d += distanceMeters(path[i], path[i + 1])
  }
  return d
}

function stripHtml(html: string): string {
  if (typeof document === "undefined") {
    return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ")
  }
  const div = document.createElement("div")
  div.innerHTML = html
  return div.textContent?.trim() ?? html.replace(/<[^>]*>/g, "")
}

function closestPathIndex(
  path: { lat: number; lng: number }[],
  lat: number,
  lng: number
): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = distanceMeters(path[i], { lat, lng })
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** Keep banner instruction readable: normalize spaces, cap length */
function formatBannerInstruction(text: string, maxLen = 70): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length <= maxLen ? t : t.slice(0, maxLen).trim() + "…"
}

function lerp(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  t: number
): { lat: number; lng: number } {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  }
}

export function MapDashboard() {
  const [mapReady, setMapReady] = useState(false)
  const { isLoaded, loadError } = useJsApiLoader({
    id: "shotgun-google-map",
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
    libraries: mapLibraries,
    version: "quarterly",
  })
  type StopDoc = { _id: Id<"stops">; label: string; lat: number; lng: number }
  const stops: StopDoc[] =
    (useQuery(api.stops.listStops) as StopDoc[] | undefined) ?? []
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
    routeSteps,
    navigationMode,
    updatePositionFromGps,
  } = useNavigation()
  const [map, setMap] = useState<google.maps.Map | null>(null)
  const [mapCenter, setMapCenter] = useState(defaultCenter)
  const [selectedDestination, setSelectedDestination] = useState<{
    lat: number
    lng: number
    address: string
    durationMinutes: number
    steps: string[]
    /** When waypoints exist: distance (mi) and added time (min) per leg to show for each stop */
    legInfo?: { distanceMeters: number; durationMinutes: number }[]
  } | null>(null)
  /** Stops/waypoints between origin and destination (in order) */
  const [waypoints, setWaypoints] = useState<{ lat: number; lng: number; address: string }[]>([])
  /** When true, next place selected from search is added as a stop instead of destination */
  const [addingStop, setAddingStop] = useState(false)
  /** When true, next place selected = add stop during active navigation (re-route) */
  const [addingStopMidRoute, setAddingStopMidRoute] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const selectedDestRef = useRef(selectedDestination)
  const waypointsRef = useRef(waypoints)
  const addingStopRef = useRef(addingStop)
  const addingStopMidRouteRef = useRef(addingStopMidRoute)
  /** Smooth car position: interpolated between path points for sliding animation */
  const [smoothCarPosition, setSmoothCarPosition] = useState<{ lat: number; lng: number } | null>(null)
  const segmentStartTimeRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  selectedDestRef.current = selectedDestination
  waypointsRef.current = waypoints
  addingStopRef.current = addingStop
  addingStopMidRouteRef.current = addingStopMidRoute
  const pathRef = useRef(path)
  const destinationRef = useRef(destination)
  const carPositionRef = useRef(carPosition)
  const destinationNameRef = useRef(destinationName)
  pathRef.current = path
  destinationRef.current = destination
  carPositionRef.current = carPosition
  destinationNameRef.current = destinationName
  const [isSimulationPaused, setIsSimulationPaused] = useState(false)
  const [userLocation, setUserLocation] = useState<{
    lat: number
    lng: number
    accuracy?: number
  } | null>(null)
  const [userLocationError, setUserLocationError] = useState<string | null>(null)
  const [nearbyPOIs, setNearbyPOIs] = useState<{ name: string; types?: string[]; lat: number; lng: number }[]>([])
  /** Results from "X near me" or "add a stop" — show list; mode determines tap action (navigate vs add as stop) */
  const [searchNearbyResults, setSearchNearbyResults] = useState<
    { name: string; address?: string; lat: number; lng: number }[]
  >([])
  /** When true, list is "add stop" options; tap or "pick first" adds as waypoint. When false, tap navigates to place. */
  const [searchResultsAddStopMode, setSearchResultsAddStopMode] = useState(false)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const dragListenerRef = useRef<google.maps.MapsEventListener | null>(null)
  const lastPanTimeRef = useRef(0)
  const lastPanPositionRef = useRef<{ lat: number; lng: number } | null>(null)

  useEffect(() => {
    if (!isLoaded) return
    const t = setTimeout(() => setMapReady(true), 150)
    return () => clearTimeout(t)
  }, [isLoaded])

  useEffect(() => {
    if (!mapReady || typeof navigator === "undefined" || !navigator.geolocation)
      return
    setUserLocationError(null)
    const onPos = (pos: GeolocationPosition) => {
      const { latitude, longitude, accuracy } = pos.coords
      setUserLocation({
        lat: latitude,
        lng: longitude,
        accuracy: accuracy ?? 50,
      })
      setMapCenter({ lat: latitude, lng: longitude })
    }
    navigator.geolocation.getCurrentPosition(
      onPos,
      (err) => setUserLocationError(err.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
    const watchId = navigator.geolocation.watchPosition(
      onPos,
      () => {},
      { enableHighAccuracy: true, maximumAge: 15000 }
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [mapReady])

  // Center map on user location as soon as we have it (when not in go mode)
  useEffect(() => {
    if (!map || !userLocation || (isGoMode && path.length > 0)) return
    map.setCenter(userLocation)
    map.setZoom(FOLLOW_ZOOM)
    setMapCenter(userLocation)
  }, [map, userLocation?.lat, userLocation?.lng, isGoMode, path.length])

  // Real mode: update car position from GPS (snap to path)
  useEffect(() => {
    if (!isGoMode || path.length === 0 || navigationMode !== "real" || !userLocation) return
    updatePositionFromGps(userLocation.lat, userLocation.lng)
  }, [isGoMode, path.length, navigationMode, userLocation?.lat, userLocation?.lng, updatePositionFromGps])

  const onLoad = useCallback((mapInstance: google.maps.Map) => {
    setMap(mapInstance)
    mapInstance.setCenter(defaultCenter)
    mapInstance.setZoom(FOLLOW_ZOOM)
    if (typeof google !== "undefined" && google.maps?.event) {
      google.maps.event.trigger(mapInstance, "resize")
    }
    dragListenerRef.current = google.maps.event.addListener(
      mapInstance,
      "dragend",
      () => {
        const c = mapInstance.getCenter()
        if (c) setMapCenter({ lat: c.lat(), lng: c.lng() })
      }
    )
    setTimeout(() => {
      if (typeof google !== "undefined" && google.maps?.event) {
        google.maps.event.trigger(mapInstance, "resize")
      }
      mapInstance.setCenter(defaultCenter)
      mapInstance.setZoom(FOLLOW_ZOOM)
    }, 400)
  }, [])

  const onUnmount = useCallback(() => {
    if (
      dragListenerRef.current &&
      typeof google !== "undefined" &&
      google.maps?.event
    ) {
      google.maps.event.removeListener(dragListenerRef.current)
      dragListenerRef.current = null
    }
    setMap(null)
  }, [])

  useEffect(() => {
    if (!isGoMode || path.length === 0 || navigationMode !== "simulation") {
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
      setSmoothCarPosition(null)
      return
    }
    if (isSimulationPaused) {
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
      setSmoothCarPosition(path[carIndex] ?? null)
      return
    }
    segmentStartTimeRef.current = Date.now()
    setSmoothCarPosition(path[carIndex] ?? null)
    tickRef.current = setInterval(tickCar, SIMULATION_INTERVAL_MS)
    return () => {
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [isGoMode, path.length, tickCar, isSimulationPaused, carIndex, path, navigationMode])

  // Smooth sliding: interpolate car position between path points every frame (only when not paused, simulation only)
  useEffect(() => {
    if (!isGoMode || path.length === 0 || navigationMode !== "simulation") return
    if (isSimulationPaused) {
      setSmoothCarPosition(path[carIndex] ?? null)
      return
    }
    const animate = () => {
      const now = Date.now()
      const elapsed = now - segmentStartTimeRef.current
      const t = Math.min(1, elapsed / SIMULATION_INTERVAL_MS)
      const idx = Math.min(carIndex, path.length - 1)
      const nextIdx = Math.min(carIndex + 1, path.length - 1)
      if (idx >= path.length - 1) {
        setSmoothCarPosition(path[path.length - 1] ?? null)
      } else {
        setSmoothCarPosition(lerp(path[idx], path[nextIdx], t))
      }
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [isGoMode, path, carIndex, isSimulationPaused, navigationMode])

  useEffect(() => {
    if (isGoMode && path.length > 0 && navigationMode === "simulation")
      segmentStartTimeRef.current = Date.now()
  }, [carIndex, isGoMode, path.length, navigationMode])

  // Nearby POIs for copilot — use dot position when in go mode (so simulation "me" = dot); throttle by ~10m to avoid refetch every frame
  const positionForPOIs = isGoMode ? (smoothCarPosition ?? carPosition) : userLocation
  const poiPositionKey =
    positionForPOIs != null
      ? `${Math.round(positionForPOIs.lat * 10000)}_${Math.round(positionForPOIs.lng * 10000)}`
      : null
  useEffect(() => {
    if (!map || !positionForPOIs || typeof google === "undefined" || !google.maps?.places) return
    const svc = new google.maps.places.PlacesService(map)
    const loc = new google.maps.LatLng(positionForPOIs.lat, positionForPOIs.lng)
    svc.nearbySearch(
      { location: loc, radius: 200 },
      (results, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !results) {
          setNearbyPOIs([])
          return
        }
        setNearbyPOIs(
          results.slice(0, 20).map((p) => ({
            name: p.name ?? "Unnamed",
            types: p.types,
            lat: p.geometry?.location?.lat() ?? 0,
            lng: p.geometry?.location?.lng() ?? 0,
          }))
        )
      }
    )
  }, [map, isGoMode, poiPositionKey])

  useEffect(() => {
    if (!map || !isGoMode || path.length === 0 || isSimulationPaused) return
    const pos =
      navigationMode === "real"
        ? carPosition
        : (smoothCarPosition ?? carPosition)
    if (!pos) return
    const now = Date.now()
    const lastPos = lastPanPositionRef.current
    const distM = lastPos ? distanceMeters(lastPos, pos) : 999
    if (lastPos && distM < 10 && now - lastPanTimeRef.current < 120) return
    lastPanTimeRef.current = now
    lastPanPositionRef.current = pos
    map.panTo(pos)
    map.setZoom(FOLLOW_ZOOM)
  }, [map, isGoMode, smoothCarPosition, carPosition, path.length, isSimulationPaused, navigationMode])

  // Google Places Autocomplete on search input (re-attach when search bar is visible)
  const showSearchBar = !isGoMode || addingStopMidRoute
  useEffect(() => {
    if (!isLoaded || !mapReady || !showSearchBar || typeof google === "undefined" || !google.maps?.places) return
    const input = searchInputRef.current
    if (!input) return
    const ac = new google.maps.places.Autocomplete(input, {
      types: ["establishment", "geocode"],
      fields: ["formatted_address", "geometry", "name"],
    })
    const listener = ac.addListener("place_changed", () => {
      const place = ac.getPlace()
      const loc = place.geometry?.location
      if (!loc) return
      const lat = loc.lat()
      const lng = loc.lng()
      const address = place.formatted_address || place.name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`
      const isAddingStop = addingStopRef.current
      const isMidRoute = addingStopMidRouteRef.current
      if (isMidRoute) {
        input.value = ""
        setAddingStopMidRoute(false)
        const origin = carPositionRef.current ?? pathRef.current[0] ?? userLocation ?? defaultCenter
        const dest = destinationRef.current ?? pathRef.current[pathRef.current.length - 1]
        if (!dest) return
        if (typeof google !== "undefined" && google.maps?.DirectionsService) {
          const ds = new google.maps.DirectionsService()
          ds.route(
            {
              origin: new google.maps.LatLng(origin.lat, origin.lng),
              destination: new google.maps.LatLng(dest.lat, dest.lng),
              waypoints: [{ location: new google.maps.LatLng(lat, lng), stopover: true }],
              travelMode: google.maps.TravelMode.DRIVING,
            },
            (result, status) => {
              if (status === "OK" && result?.routes?.[0]?.overview_path?.length) {
                const pathLatLng = result.routes[0].overview_path.map((p) => ({
                  lat: p.lat(),
                  lng: p.lng(),
                }))
                const legs = result.routes[0].legs ?? []
                const steps: RouteStep[] = []
                for (const leg of legs) {
                  for (const s of leg.steps ?? []) {
                    steps.push({
                      instructionText: s.instructions ? stripHtml(s.instructions) : "Continue",
                      pathIndex: s.start_location
                        ? closestPathIndex(pathLatLng, s.start_location.lat(), s.start_location.lng())
                        : 0,
                    })
                  }
                }
                startNavigationWithPath(pathLatLng, destinationNameRef.current ?? undefined, steps, navigationMode)
              }
            }
          )
        }
        return
      }
      if (isAddingStop) {
        const currentWaypoints = waypointsRef.current
        const newWaypoints = [...currentWaypoints, { lat, lng, address }]
        setWaypoints(newWaypoints)
        input.value = ""
        setAddingStop(false)
        const origin = userLocation ?? defaultCenter
        const dest = selectedDestRef.current
        if (dest) {
          fetchRouteAndSetPanel(origin, { lat: dest.lat, lng: dest.lng }, dest.address, newWaypoints)
        }
      } else {
        setSelectedDestination({
          lat,
          lng,
          address,
          durationMinutes: 0,
          steps: [],
        })
        setWaypoints([])
        input.value = ""
        fetchRouteAndSetPanel(userLocation ?? defaultCenter, { lat, lng }, address, [])
      }
    })
    autocompleteRef.current = ac
    return () => {
      google.maps.event.removeListener(listener)
      autocompleteRef.current = null
    }
  }, [isLoaded, mapReady, showSearchBar, navigationMode, startNavigationWithPath])

  function fetchRouteAndSetPanel(
    origin: { lat: number; lng: number },
    dest: { lat: number; lng: number },
    destName: string,
    mids: { lat: number; lng: number; address: string }[]
  ) {
    if (typeof google === "undefined" || !google.maps?.DirectionsService) return
    const ds = new google.maps.DirectionsService()
    const waypointsForRequest = mids.map((m) => ({
      location: new google.maps.LatLng(m.lat, m.lng),
      stopover: true,
    }))
    ds.route(
      {
        origin: new google.maps.LatLng(origin.lat, origin.lng),
        destination: new google.maps.LatLng(dest.lat, dest.lng),
        waypoints: waypointsForRequest,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (result, status) => {
        if (status !== "OK" || !result?.routes?.[0]?.legs?.length) return
        const legs = result.routes[0].legs
        const legInfo = legs.map((leg) => ({
          distanceMeters: leg.distance?.value ?? 0,
          durationMinutes: Math.ceil((leg.duration?.value ?? 0) / 60),
        }))
        let totalMins = 0
        legInfo.forEach((l) => (totalMins += l.durationMinutes))
        const allSteps: string[] = []
        legs.forEach((leg) => {
          ;(leg.steps ?? []).forEach((s) => {
            if (s.instructions) allSteps.push(stripHtml(s.instructions))
          })
        })
        setSelectedDestination((prev) =>
          prev && prev.lat === dest.lat && prev.lng === dest.lng
            ? {
                ...prev,
                address: destName,
                durationMinutes: totalMins,
                steps: allSteps,
                legInfo,
              }
            : prev
        )
      }
    )
  }

  const pathForPolyline = path.map((p) => ({ lat: p.lat, lng: p.lng }))
  const mapOptions: google.maps.MapOptions = {
    ...mapOptionsBase,
    center: mapCenter,
  }

  const nextStep: RouteStep | null =
    routeSteps.find((s) => s.pathIndex > carIndex) ?? null
  const distanceToNextTurn =
    nextStep != null
      ? pathSegmentDistance(path, carIndex, nextStep.pathIndex)
      : null
  const arrived = carIndex >= path.length - 1

  const currentStepText =
    routeSteps.find((s) => s.pathIndex <= carIndex)?.instructionText ?? undefined
  const positionForContext = smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter
  const posAsCoord = positionForContext as { lat: number; lng: number }
  const heading =
    isGoMode && path.length > 1
      ? bearingDeg(posAsCoord, path[Math.min(carIndex + 1, path.length - 1)])
      : undefined
  const nearbyPOIsWithSide =
    nearbyPOIs.length > 0
      ? nearbyPOIs
          .map((poi) => {
            const distance_m = Math.round(distanceMeters(posAsCoord, { lat: poi.lat, lng: poi.lng }))
            const side =
              heading != null
                ? ((bearingDeg(posAsCoord, { lat: poi.lat, lng: poi.lng }) - heading + 540) % 360) - 180 > 0
                  ? ("right" as const)
                  : ("left" as const)
                : undefined
            return { ...poi, distance_m, side }
          })
          .sort((a, b) => a.distance_m - b.distance_m)
          .slice(0, 15)
      : []
  const copilotContext: CopilotContext = {
    position: posAsCoord,
    destination: destination ?? (path.length > 0 ? path[path.length - 1] ?? undefined : undefined),
    currentStepText,
    nextStepText: nextStep?.instructionText,
    destinationName: destinationName ?? undefined,
    hasActiveRoute: isGoMode && path.length > 0,
    navigationMode: isGoMode ? navigationMode : undefined,
    heading,
    nearbyPOIs: nearbyPOIsWithSide.length > 0 ? nearbyPOIsWithSide : undefined,
    addStopOptions: searchResultsAddStopMode && searchNearbyResults.length > 0 ? searchNearbyResults : undefined,
  }

  const handleAddStopWithQuery = useCallback(
    (query: string, _maxMinutesAdded?: number, _maxMinutesFromNow?: number) => {
      const origin = smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter
      const openSearchWithQuery = (forMidRoute: boolean) => {
        if (forMidRoute) setAddingStopMidRoute(true)
        else setAddingStop(true)
        setTimeout(() => {
          if (searchInputRef.current) searchInputRef.current.value = query
        }, 100)
      }
      if (!map || typeof google === "undefined" || !google.maps?.places) {
        if (map) openSearchWithQuery(isGoMode)
        return
      }
      const places = new google.maps.places.PlacesService(map)
      const loc = new google.maps.LatLng(origin.lat, origin.lng)
      places.textSearch({ query, location: loc }, (results, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !results?.length) {
          openSearchWithQuery(isGoMode)
          return
        }
        setSearchNearbyResults(
          results.slice(0, 8).map((p) => ({
            name: p.name ?? "Unnamed",
            address: p.formatted_address,
            lat: p.geometry?.location?.lat() ?? 0,
            lng: p.geometry?.location?.lng() ?? 0,
          }))
        )
        setSearchResultsAddStopMode(true)
      })
    },
    [map, isGoMode, smoothCarPosition, carPosition, userLocation]
  )

  /** Add a place as a waypoint: re-route through it (when navigating) or add to waypoints and refresh route (when planning). */
  const addPlaceAsStop = useCallback(
    (place: { name: string; address?: string; lat: number; lng: number }) => {
      const origin = smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter
      const dest = destination ?? (path.length > 0 ? path[path.length - 1] : null)
      setSearchNearbyResults([])
      setSearchResultsAddStopMode(false)
      if (!map || typeof google === "undefined" || !google.maps?.DirectionsService) return
      if (isGoMode && dest) {
        const ds = new google.maps.DirectionsService()
        ds.route(
          {
            origin: new google.maps.LatLng(origin.lat, origin.lng),
            destination: new google.maps.LatLng(dest.lat, dest.lng),
            waypoints: [{ location: new google.maps.LatLng(place.lat, place.lng), stopover: true }],
            travelMode: google.maps.TravelMode.DRIVING,
          },
          (result, status) => {
            if (status !== "OK" || !result?.routes?.[0]?.overview_path?.length) return
            const pathLatLng = result.routes[0].overview_path.map((p: google.maps.LatLng) => ({
              lat: p.lat(),
              lng: p.lng(),
            }))
            const legs = result.routes[0].legs ?? []
            const steps: RouteStep[] = []
            legs.forEach((leg: google.maps.DirectionsLeg) => {
              ;(leg.steps ?? []).forEach((s: google.maps.DirectionsStep) => {
                steps.push({
                  instructionText: s.instructions ? stripHtml(s.instructions) : "Continue",
                  pathIndex: s.start_location
                    ? closestPathIndex(pathLatLng, s.start_location.lat(), s.start_location.lng())
                    : 0,
                })
              })
            })
            setIsSimulationPaused(false)
            startNavigationWithPath(pathLatLng, destinationName ?? undefined, steps, navigationMode)
          }
        )
      } else {
        const newWaypoints = [...waypoints, { lat: place.lat, lng: place.lng, address: place.name }]
        setWaypoints(newWaypoints)
        const sel = selectedDestination
        if (sel) {
          fetchRouteAndSetPanel(origin, { lat: sel.lat, lng: sel.lng }, sel.address, newWaypoints)
        }
      }
    },
    [map, isGoMode, smoothCarPosition, carPosition, userLocation, destination, path, destinationName, waypoints, selectedDestination, startNavigationWithPath, navigationMode]
  )

  const handlePickOption = useCallback(
    (index: number) => {
      if (!searchResultsAddStopMode || index < 0 || index >= searchNearbyResults.length) return
      addPlaceAsStop(searchNearbyResults[index])
    },
    [searchResultsAddStopMode, searchNearbyResults, addPlaceAsStop]
  )

  const handleRequestAlternateRoute = useCallback(() => {
    const origin = smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter
    const dest = destination ?? (path.length > 0 ? path[path.length - 1] : null)
    if (!dest || typeof google === "undefined" || !google.maps?.DirectionsService) return
    const ds = new google.maps.DirectionsService()
    ds.route(
      {
        origin: new google.maps.LatLng(origin.lat, origin.lng),
        destination: new google.maps.LatLng(dest.lat, dest.lng),
        travelMode: google.maps.TravelMode.DRIVING,
        provideRouteAlternatives: true,
      },
      (result, status) => {
        if (status !== "OK" || !result?.routes?.length || result.routes.length < 2) return
        const alt = result.routes[1]
        const pathLatLng = alt.overview_path.map((p: google.maps.LatLng) => ({ lat: p.lat(), lng: p.lng() }))
        const legs = alt.legs ?? []
        const steps: RouteStep[] = []
        legs.forEach((leg: google.maps.DirectionsLeg) => {
          ;(leg.steps ?? []).forEach((s: google.maps.DirectionsStep) => {
            steps.push({
              instructionText: s.instructions ? stripHtml(s.instructions) : "Continue",
              pathIndex: s.start_location
                ? closestPathIndex(pathLatLng, s.start_location.lat(), s.start_location.lng())
                : 0,
            })
          })
        })
        startNavigationWithPath(pathLatLng, destinationName ?? undefined, steps, navigationMode)
      }
    )
  }, [smoothCarPosition, carPosition, userLocation, destination, path, destinationName, startNavigationWithPath, navigationMode])

  const handleNavigateTo = useCallback(
    (query: string) => {
      const origin = userLocation ?? defaultCenter
      if (!map || typeof google === "undefined" || !google.maps?.places || !google.maps?.DirectionsService) return
      const places = new google.maps.places.PlacesService(map)
      const loc = new google.maps.LatLng(origin.lat, origin.lng)
      places.textSearch({ query, location: loc }, (results, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !results?.length) return
        const p = results[0]
        const lat = p.geometry?.location?.lat()
        const lng = p.geometry?.location?.lng()
        if (lat == null || lng == null) return
        const destName = p.name ?? p.formatted_address ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
        const ds = new google.maps.DirectionsService()
        ds.route(
          {
            origin: new google.maps.LatLng(origin.lat, origin.lng),
            destination: new google.maps.LatLng(lat, lng),
            travelMode: google.maps.TravelMode.DRIVING,
          },
          (result, routeStatus) => {
            if (routeStatus !== "OK" || !result?.routes?.[0]?.overview_path?.length) return
            const pathLatLng = result.routes[0].overview_path.map((pt: google.maps.LatLng) => ({
              lat: pt.lat(),
              lng: pt.lng(),
            }))
            const legs = result.routes[0].legs ?? []
            const steps: RouteStep[] = []
            legs.forEach((leg: google.maps.DirectionsLeg) => {
              ;(leg.steps ?? []).forEach((s: google.maps.DirectionsStep) => {
                steps.push({
                  instructionText: s.instructions ? stripHtml(s.instructions) : "Continue",
                  pathIndex: s.start_location
                    ? closestPathIndex(pathLatLng, s.start_location.lat(), s.start_location.lng())
                    : 0,
                })
              })
            })
            setIsSimulationPaused(false)
            startNavigationWithPath(pathLatLng, destName, steps, "real")
          }
        )
      })
    },
    [map, userLocation, startNavigationWithPath]
  )

  /** Navigate to a specific place by coords (e.g. after user picks from search_nearby results). */
  const handleNavigateToPlace = useCallback(
    (lat: number, lng: number, destName: string) => {
      const origin = userLocation ?? defaultCenter
      if (!map || typeof google === "undefined" || !google.maps?.DirectionsService) return
      const ds = new google.maps.DirectionsService()
      ds.route(
        {
          origin: new google.maps.LatLng(origin.lat, origin.lng),
          destination: new google.maps.LatLng(lat, lng),
          travelMode: google.maps.TravelMode.DRIVING,
        },
        (result, routeStatus) => {
          if (routeStatus !== "OK" || !result?.routes?.[0]?.overview_path?.length) return
          const pathLatLng = result.routes[0].overview_path.map((pt: google.maps.LatLng) => ({
            lat: pt.lat(),
            lng: pt.lng(),
          }))
          const legs = result.routes[0].legs ?? []
          const steps: RouteStep[] = []
          legs.forEach((leg: google.maps.DirectionsLeg) => {
            ;(leg.steps ?? []).forEach((s: google.maps.DirectionsStep) => {
              steps.push({
                instructionText: s.instructions ? stripHtml(s.instructions) : "Continue",
                pathIndex: s.start_location
                  ? closestPathIndex(pathLatLng, s.start_location.lat(), s.start_location.lng())
                  : 0,
              })
            })
          })
          setSearchNearbyResults([])
          setIsSimulationPaused(false)
          startNavigationWithPath(pathLatLng, destName, steps, "real")
        }
      )
    },
    [map, userLocation, startNavigationWithPath]
  )

  /** "Vegetarian options near me" etc.: run Places search near user, show results for user to pick. */
  const handleSearchNearby = useCallback(
    (query: string) => {
      setSearchResultsAddStopMode(false)
      const origin = userLocation ?? defaultCenter
      if (!map || typeof google === "undefined" || !google.maps?.places) return
      const places = new google.maps.places.PlacesService(map)
      const loc = new google.maps.LatLng(origin.lat, origin.lng)
      places.textSearch({ query, location: loc }, (results, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !results?.length) {
          setSearchNearbyResults([])
          return
        }
        setSearchNearbyResults(
          results.slice(0, 8).map((p) => ({
            name: p.name ?? "Unnamed",
            address: p.formatted_address,
            lat: p.geometry?.location?.lat() ?? 0,
            lng: p.geometry?.location?.lng() ?? 0,
          }))
        )
      })
    },
    [map, userLocation]
  )

  if (loadError) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-zinc-950 text-red-400">
        Could not load the map. Check your Google Maps API key.
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
    <div
      className="relative w-full bg-zinc-950"
      style={{
        height: "100vh",
        minHeight: 400,
        paddingTop: isGoMode && path.length > 0 ? 64 : 0,
      }}
    >
      {/* Search bar: smart place search (Places Autocomplete) */}
      {/* Search bar: when planning or when adding stop mid-route */}
      {(!isGoMode || addingStopMidRoute) && (
        <div
          className="absolute left-0 right-0 z-20 flex items-center gap-2 bg-zinc-900/95 px-3 py-2 shadow-md backdrop-blur"
          style={isGoMode && addingStopMidRoute ? { top: 64 } : {}}
        >
          <input
            ref={searchInputRef}
            type="text"
            placeholder={
              addingStopMidRoute
                ? "Search for a place to add (you’ll go there next)..."
                : addingStop
                  ? "Search for a place to add as stop..."
                  : "Search destination or place..."
            }
            className="flex-1 rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            aria-label="Search destination or place"
          />
          {(addingStop || addingStopMidRoute) && (
            <button
              type="button"
              onClick={() => {
                setAddingStop(false)
                setAddingStopMidRoute(false)
              }}
              className="shrink-0 rounded-lg bg-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-600"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      <div
        id="next-direction-banner"
        className="next-direction-banner"
        aria-live="polite"
        hidden={!isGoMode || path.length === 0}
      >
        <span className="banner-instruction">
          {arrived
            ? "You have arrived."
            : nextStep
              ? formatBannerInstruction(nextStep.instructionText)
              : "Head toward " + (destinationName ?? "destination")}
        </span>
        <span className="banner-distance">
          {arrived
            ? ""
            : distanceToNextTurn != null && distanceToNextTurn >= 0
              ? distanceToNextTurn >= 1000
                ? `in ${(distanceToNextTurn / 1000).toFixed(1)} km`
                : `in ${Math.round(distanceToNextTurn)} m`
              : ""}
        </span>
      </div>

      <div
        className="absolute left-0 right-0 w-full"
        style={{
          top: isGoMode && path.length > 0 ? 64 : !isGoMode ? SEARCH_BAR_HEIGHT : 0,
          height: !isGoMode
            ? `calc(100vh - ${SEARCH_BAR_HEIGHT}px)`
            : isGoMode && path.length > 0
              ? "calc(100vh - 64px)"
              : "100vh",
        }}
      >
        <GoogleMap
          mapContainerStyle={{
            width: "100%",
            height: !isGoMode
              ? `calc(100vh - ${SEARCH_BAR_HEIGHT}px)`
              : isGoMode && path.length > 0
                ? "calc(100vh - 64px)"
                : "100vh",
          }}
          center={mapCenter}
          zoom={FOLLOW_ZOOM}
          onLoad={onLoad}
          onUnmount={onUnmount}
          onClick={(e) => {
            if (e.latLng) {
              const lat = e.latLng.lat()
              const lng = e.latLng.lng()
              const origin = userLocation ?? defaultCenter
              const updateAddress = (addr: string) => {
                setSelectedDestination((prev) =>
                  prev && prev.lat === lat && prev.lng === lng
                    ? { ...prev, address: addr }
                    : prev
                )
              }
              const updateDuration = (mins: number) => {
                setSelectedDestination((prev) =>
                  prev && prev.lat === lat && prev.lng === lng
                    ? { ...prev, durationMinutes: mins }
                    : prev
                )
              }
              const updateSteps = (steps: string[]) => {
                setSelectedDestination((prev) =>
                  prev && prev.lat === lat && prev.lng === lng
                    ? { ...prev, steps }
                    : prev
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
              if (
                typeof google !== "undefined" &&
                google.maps?.DirectionsService
              ) {
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
                        .map((s) =>
                          s.instructions
                            ? stripHtml(s.instructions)
                            : ""
                        )
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
              position={{
                lat: selectedDestination.lat,
                lng: selectedDestination.lng,
              }}
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
          {waypoints.map((wp, i) => (
            <Marker
              key={i}
              position={{ lat: wp.lat, lng: wp.lng }}
              title={wp.address}
              icon={{
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: "#f59e0b",
                fillOpacity: 1,
                strokeColor: "#1e293b",
                strokeWeight: 2,
              }}
            />
          ))}
          {userLocation && !isGoMode && (
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
          {isGoMode && (carPosition || smoothCarPosition) && (
            <Marker
              position={
                navigationMode === "real"
                  ? (carPosition ?? defaultCenter)
                  : (smoothCarPosition ?? carPosition ?? defaultCenter)
              }
              title={navigationMode === "real" ? "Your location" : "Simulated location"}
              icon={{
                path: google.maps.SymbolPath.CIRCLE,
                scale: 12,
                fillColor: navigationMode === "real" ? "#007AFF" : "#facc15",
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
        <div className="absolute bottom-0 left-0 right-0 z-10 max-h-[55vh] overflow-y-auto rounded-t-2xl border border-zinc-700 bg-zinc-900 px-4 py-4 shadow-[0_-4px_20px_rgba(0,0,0,0.4)]">
          <p className="font-semibold text-zinc-100">
            {selectedDestination.address}
          </p>
          <p className="mt-0.5 text-sm text-zinc-400">
            {selectedDestination.durationMinutes > 0
              ? `~${selectedDestination.durationMinutes} min total`
              : "Getting route…"}
          </p>

          {/* Stops with distance and time added */}
          {waypoints.length > 0 && selectedDestination.legInfo && (
            <div className="mt-3 space-y-2 border-t border-zinc-700 pt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Stops
              </p>
              {waypoints.map((wp, i) => {
                const leg = selectedDestination.legInfo![i]
                if (!leg) return null
                const mi = (leg.distanceMeters / 1609.34).toFixed(1)
                return (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-lg bg-zinc-800/80 px-3 py-2 text-sm"
                  >
                    <span className="text-zinc-300 line-clamp-1">{wp.address}</span>
                    <span className="shrink-0 text-cyan-400">
                      {mi} mi · +{leg.durationMinutes} min
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {selectedDestination.steps.length > 0 && (
            <div className="mt-3 border-t border-zinc-700 pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Turn-by-turn
              </p>
              <ol className="space-y-1.5 text-sm text-zinc-400">
                {selectedDestination.steps.slice(0, 8).map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 font-medium text-zinc-500">
                      {i + 1}.
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
                {selectedDestination.steps.length > 8 && (
                  <li className="text-zinc-500">
                    +{selectedDestination.steps.length - 8} more
                  </li>
                )}
              </ol>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${selectedDestination.lat},${selectedDestination.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-cyan-400 hover:underline"
            >
              Open in Google Maps
            </a>
            <button
              type="button"
              onClick={() => setAddingStop(true)}
              className="rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-700 hover:text-zinc-100"
            >
              + Add stop
            </button>
            <span className="text-zinc-500">|</span>
            <button
              type="button"
              onClick={() => {
                const origin = userLocation ?? defaultCenter
                const dest = {
                  lat: selectedDestination.lat,
                  lng: selectedDestination.lng,
                }
                const destName = selectedDestination.address
                const runNav = (mode: "real" | "simulation") => {
                  if (
                    typeof google !== "undefined" &&
                    google.maps?.DirectionsService
                  ) {
                    const ds = new google.maps.DirectionsService()
                    const waypointsForRequest = waypoints.map((w) => ({
                      location: new google.maps.LatLng(w.lat, w.lng),
                      stopover: true,
                    }))
                    ds.route(
                      {
                        origin: new google.maps.LatLng(origin.lat, origin.lng),
                        destination: new google.maps.LatLng(dest.lat, dest.lng),
                        waypoints: waypointsForRequest,
                        travelMode: google.maps.TravelMode.DRIVING,
                      },
                      (result, status) => {
                        if (
                          status === "OK" &&
                          result?.routes?.[0]?.overview_path?.length
                        ) {
                          const pathLatLng = result.routes[0].overview_path.map(
                            (p) => ({ lat: p.lat(), lng: p.lng() })
                          )
                          const legs = result.routes[0].legs ?? []
                          const steps: RouteStep[] = []
                          for (const leg of legs) {
                            for (const s of leg.steps ?? []) {
                              const instructionText = s.instructions
                                ? stripHtml(s.instructions)
                                : "Continue"
                              const pathIndex = s.start_location
                                ? closestPathIndex(
                                    pathLatLng,
                                    s.start_location.lat(),
                                    s.start_location.lng()
                                  )
                                : 0
                              steps.push({ instructionText, pathIndex })
                            }
                          }
                          setIsSimulationPaused(false)
                          startNavigationWithPath(pathLatLng, destName, steps, mode)
                        } else {
                          setIsSimulationPaused(false)
                          startNavigationWithPath([origin, dest], destName, undefined, mode)
                        }
                        setSelectedDestination(null)
                        setWaypoints([])
                      }
                    )
                  } else {
                    setIsSimulationPaused(false)
                    startNavigationWithPath([origin, dest], destName, undefined, mode)
                    setSelectedDestination(null)
                    setWaypoints([])
                  }
                }
                runNav("real")
              }}
              className="rounded-xl border-2 border-cyan-500 bg-zinc-900 px-4 py-2.5 font-medium text-cyan-400 transition hover:bg-cyan-500/20 hover:text-cyan-300"
            >
              Start (GPS)
            </button>
            <button
              type="button"
              onClick={() => {
                const origin = userLocation ?? defaultCenter
                const dest = {
                  lat: selectedDestination.lat,
                  lng: selectedDestination.lng,
                }
                const destName = selectedDestination.address
                const runNav = (mode: "real" | "simulation") => {
                  if (
                    typeof google !== "undefined" &&
                    google.maps?.DirectionsService
                  ) {
                    const ds = new google.maps.DirectionsService()
                    const waypointsForRequest = waypoints.map((w) => ({
                      location: new google.maps.LatLng(w.lat, w.lng),
                      stopover: true,
                    }))
                    ds.route(
                      {
                        origin: new google.maps.LatLng(origin.lat, origin.lng),
                        destination: new google.maps.LatLng(dest.lat, dest.lng),
                        waypoints: waypointsForRequest,
                        travelMode: google.maps.TravelMode.DRIVING,
                      },
                      (result, status) => {
                        if (
                          status === "OK" &&
                          result?.routes?.[0]?.overview_path?.length
                        ) {
                          const pathLatLng = result.routes[0].overview_path.map(
                            (p) => ({ lat: p.lat(), lng: p.lng() })
                          )
                          const legs = result.routes[0].legs ?? []
                          const steps: RouteStep[] = []
                          for (const leg of legs) {
                            for (const s of leg.steps ?? []) {
                              const instructionText = s.instructions
                                ? stripHtml(s.instructions)
                                : "Continue"
                              const pathIndex = s.start_location
                                ? closestPathIndex(
                                    pathLatLng,
                                    s.start_location.lat(),
                                    s.start_location.lng()
                                  )
                                : 0
                              steps.push({ instructionText, pathIndex })
                            }
                          }
                          setIsSimulationPaused(false)
                          startNavigationWithPath(pathLatLng, destName, steps, mode)
                        } else {
                          setIsSimulationPaused(false)
                          startNavigationWithPath([origin, dest], destName, undefined, mode)
                        }
                        setSelectedDestination(null)
                        setWaypoints([])
                      }
                    )
                  } else {
                    setIsSimulationPaused(false)
                    startNavigationWithPath([origin, dest], destName, undefined, mode)
                    setSelectedDestination(null)
                    setWaypoints([])
                  }
                }
                runNav("simulation")
              }}
              className="rounded-xl border-2 border-amber-500 bg-zinc-900 px-4 py-2.5 font-medium text-amber-400 transition hover:bg-amber-500/20 hover:text-amber-300"
            >
              Simulate (demo)
            </button>
          </div>
        </div>
      )}

      {isGoMode && path.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center justify-between gap-4 rounded-t-2xl border-t border-zinc-200 bg-white pl-8 pr-4 py-4 shadow-[0_-4px_20px_rgba(0,0,0,0.15)] dark:border-zinc-700 dark:bg-zinc-900">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-zinc-900 dark:text-zinc-100">
              {arrived
                ? "You have arrived"
                : nextStep
                  ? nextStep.instructionText
                  : "Head toward " + (destinationName ?? "destination")}
            </p>
            <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
              {arrived
                ? destinationName ?? "Destination"
                : distanceToNextTurn != null
                  ? `in ${distanceToNextTurn >= 1000 ? (distanceToNextTurn / 1000).toFixed(1) + " km" : Math.round(distanceToNextTurn) + " m"}`
                  : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAddingStopMidRoute(true)}
            className="shrink-0 rounded-lg border border-zinc-500 bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
          >
            Add stop
          </button>
          {navigationMode === "simulation" && (
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
          )}
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
        </div>
      )}

      {userLocationError && !isGoMode && (
        <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-lg border border-zinc-600 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-400 backdrop-blur">
          Location unavailable. Enable location access to see your position.
        </div>
      )}
      {!isGoMode && !selectedDestination && (
        <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-900/90 px-4 py-2.5 text-center text-sm text-zinc-400 backdrop-blur">
          Search for a destination above or click the map to set a place
        </div>
      )}

      {/* Add-stop or search-nearby results — tap or say "pick the first option" */}
      {searchNearbyResults.length > 0 && (
        <div className="absolute bottom-24 left-2 right-2 z-20 max-h-64 overflow-y-auto rounded-xl border border-zinc-600 bg-zinc-900/98 shadow-xl backdrop-blur">
          <div className="sticky top-0 flex items-center justify-between border-b border-zinc-700 bg-zinc-900/95 px-3 py-2">
            <span className="text-sm font-medium text-zinc-300">
              {searchResultsAddStopMode ? "Add a stop — pick one (or say “pick the first option”)" : "Nearby results"}
            </span>
            <button
              type="button"
              onClick={() => {
                setSearchNearbyResults([])
                setSearchResultsAddStopMode(false)
              }}
              className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
            >
              Close
            </button>
          </div>
          <ul className="divide-y divide-zinc-700">
            {searchNearbyResults.map((place, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() =>
                    searchResultsAddStopMode
                      ? addPlaceAsStop(place)
                      : handleNavigateToPlace(place.lat, place.lng, place.name)
                  }
                  className="w-full px-3 py-2.5 text-left text-sm text-zinc-200 hover:bg-zinc-800"
                >
                  <span className="font-medium">{place.name}</span>
                  {place.address && (
                    <span className="mt-0.5 block truncate text-xs text-zinc-500">{place.address}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <VoiceCopilot
        context={copilotContext}
        onAddStopWithQuery={handleAddStopWithQuery}
        onRequestAlternateRoute={handleRequestAlternateRoute}
        onNavigateTo={handleNavigateTo}
        onSearchNearby={handleSearchNearby}
        onPickOption={handlePickOption}
      />
    </div>
  )
}
