"use client"

/**
 * Map Dashboard — Google Maps + Convex: simulation, follow-cam, turn-by-turn banner, voice copilot.
 */

import {
  GoogleMap,
  useJsApiLoader,
  Marker,
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
/** Speed multiplier for simulation: 0.25 = slow, 1 = normal, 5 = fast. Effective interval = SIMULATION_INTERVAL_MS / multiplier. */
const SIMULATION_SPEED_MIN = 0.25
const SIMULATION_SPEED_MAX = 5
const SIMULATION_SPEED_DEFAULT = 1
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

/** Highway exit/merge: say which lane to get in when within this distance (1 km). */
const LANE_CHIME_DISTANCE_M = 1000
/** Within this many meters of the turn, say the "do it now" chime (e.g. "Turn left here"). Only one per maneuver. */
const PROACTIVE_CHIME_AT_TURN_DISTANCE_M = 150
/** Don't say "turn here" when closer than this—avoids speaking right as they're turning. */
const PROACTIVE_CHIME_AT_TURN_MIN_DISTANCE_M = 50

/** True if the step is for a major road (highway, merge, exit, ramp) where lane guidance matters. */
function isMajorRoadStep(instructionText: string): boolean {
  const t = instructionText.toLowerCase()
  return (
    /\b(merge|exit|ramp|interstate|highway|freeway)\b/.test(t) ||
    /\bi-\d|\bus\s*\d|state\s*route|route\s+\d|hwy\s*\d/.test(t) ||
    /\bkeep\s+(left|right)\b/.test(t)
  )
}

function getChimePhrase(step: RouteStep): string {
  const t = step.instructionText.toLowerCase()
  if (isMajorRoadStep(step.instructionText)) {
    const isExit = /\b(exit|ramp|take\s+exit)\b/.test(t)
    const isMerge = /\bmerge\b/.test(t)
    if (isExit) {
      if (/left|take\s+the\s+left\s+exit/.test(t)) return "Take the left lane to exit."
      if (/right|ramp|exit/.test(t)) return "Take the right lane to exit."
      return "Take the right lane to exit."
    }
    if (isMerge) {
      if (/right|merge\s+right/.test(t)) return "Take the right lane to merge."
      if (/left|merge\s+left|keep\s+left/.test(t)) return "Take the left lane to merge."
      return "Take the right lane to merge."
    }
    if (/right|keep\s+right/.test(t)) return "Get in the right lane for your next turn."
    if (/left|keep\s+left/.test(t)) return "Get in the left lane for your next turn."
    return "Get in position for your next turn."
  }
  if (/turn\s+left/.test(t)) return "Turn left here."
  if (/turn\s+right/.test(t)) return "Turn right here."
  if (/slight\s+left/.test(t)) return "Slight left here."
  if (/slight\s+right/.test(t)) return "Slight right here."
  return "Get ready for your next turn."
}

/** Short "do it now" phrase when very close to the turn (used for at-turn chime). */
function getChimePhraseAtTurn(step: RouteStep): string {
  const t = step.instructionText.toLowerCase()
  if (isMajorRoadStep(step.instructionText)) {
    const isExit = /\b(exit|ramp|take\s+exit)\b/.test(t)
    const isMerge = /\bmerge\b/.test(t)
    if (isExit) return "Take the exit now."
    if (isMerge) return "Merge here."
    return "Turn here."
  }
  if (/turn\s+left/.test(t)) return "Turn left here."
  if (/turn\s+right/.test(t)) return "Turn right here."
  if (/slight\s+left/.test(t)) return "Slight left here."
  if (/slight\s+right/.test(t)) return "Slight right here."
  return "Turn here."
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

/** One continuous path: origin → … → stop → … → destination.
 * Uses the route’s overview_path (single polyline from Google) so we never draw two segments.
 * Steps and waypoints are built from legs for turn-by-turn and pins. */
function buildPathStepsAndWaypointsFromRoute(
  route: google.maps.DirectionsRoute
): { pathLatLng: { lat: number; lng: number }[]; steps: RouteStep[]; waypoints: { lat: number; lng: number; name?: string }[] } {
  const legs = route.legs ?? []
  // Use overview_path so we have exactly one continuous line (optimal route) for the whole journey
  const pathLatLng: { lat: number; lng: number }[] =
    route.overview_path && route.overview_path.length > 0
      ? route.overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() }))
      : []

  const steps: RouteStep[] = []
  legs.forEach((leg: google.maps.DirectionsLeg) => {
    (leg.steps ?? []).forEach((s: google.maps.DirectionsStep) => {
      const pathIndex =
        pathLatLng.length > 0 && s.start_location
          ? closestPathIndex(pathLatLng, s.start_location.lat(), s.start_location.lng())
          : 0
      steps.push({
        instructionText: s.instructions ? stripHtml(s.instructions) : "Continue",
        pathIndex,
      })
    })
  })

  // If no overview_path (shouldn’t happen), build path from legs so we still have something to draw
  if (pathLatLng.length === 0) {
    for (const leg of legs) {
      const stepList = leg.steps ?? []
      for (let i = 0; i < stepList.length; i++) {
        const s = stepList[i]
        if (pathLatLng.length === 0)
          pathLatLng.push({ lat: s.start_location.lat(), lng: s.start_location.lng() })
        pathLatLng.push({ lat: s.end_location.lat(), lng: s.end_location.lng() })
      }
    }
  }

  const waypoints = legs.slice(0, -1).map((leg) => ({
    lat: leg.end_location.lat(),
    lng: leg.end_location.lng(),
    name: leg.end_address,
  }))
  return { pathLatLng, steps, waypoints }
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
    routeWaypoints,
    navigationMode,
    updatePositionFromGps,
    routeVersion,
    startPoint,
    setStartPoint: setStartPointNav,
    clearStartPoint,
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
  /** When true, next place selected from search bar becomes route start (for "Start from" in panel). */
  const [searchForStartLocation, setSearchForStartLocation] = useState(false)
  /** Display label for custom start (e.g. address); when null, show "Current location". */
  const [startPointAddress, setStartPointAddress] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const selectedDestRef = useRef(selectedDestination)
  const waypointsRef = useRef(waypoints)
  const addingStopRef = useRef(addingStop)
  const addingStopMidRouteRef = useRef(addingStopMidRoute)
  const searchForStartRef = useRef(false)
  /** Smooth car position: interpolated between path points for sliding animation (real mode only; simulation uses refs) */
  const [smoothCarPosition, setSmoothCarPosition] = useState<{ lat: number; lng: number } | null>(null)
  /** Single location state for simulation; only source of truth. Updated at low frequency for POI/copilot; marker/camera use ref. */
  const [simLocation, setSimLocation] = useState<{ lat: number; lng: number } | null>(null)
  const segmentStartTimeRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  /** Imperative blue-dot marker in simulation: created once, updated in RAF, never re-mounted. */
  const carMarkerRef = useRef<google.maps.Marker | null>(null)
  /** Current simulator position (RAF writes, no React state). Keeps dot centered and camera smooth. */
  const simPositionRef = useRef<{ lat: number; lng: number } | null>(null)
  /** Segment index for simulation; advanced in RAF to avoid re-renders. Synced to context via tickCar(). */
  const simCarIndexRef = useRef(0)
  /** Throttle: last time we pushed simLocation to state for POI/copilot (avoid re-renders every frame) */
  const lastSimLocationStateUpdateRef = useRef(0)
  selectedDestRef.current = selectedDestination
  waypointsRef.current = waypoints
  addingStopRef.current = addingStop
  addingStopMidRouteRef.current = addingStopMidRoute
  searchForStartRef.current = searchForStartLocation
  const pathRef = useRef(path)
  const destinationRef = useRef(destination)
  const carPositionRef = useRef(carPosition)
  const carIndexRef = useRef(carIndex)
  const destinationNameRef = useRef(destinationName)
  pathRef.current = path
  destinationRef.current = destination
  carPositionRef.current = carPosition
  carIndexRef.current = carIndex
  destinationNameRef.current = destinationName
  /** Exactly ONE route polyline on the map. Remove before creating a new one. */
  const currentRoutePolylineRef = useRef<google.maps.Polyline | null>(null)
  const [isSimulationPaused, setIsSimulationPaused] = useState(false)
  /** 0.25 = slow, 1 = normal, 3 = fast. RAF uses SIMULATION_INTERVAL_MS / this value. */
  const [simulationSpeed, setSimulationSpeed] = useState(SIMULATION_SPEED_DEFAULT)
  const simulationSpeedRef = useRef(simulationSpeed)
  simulationSpeedRef.current = simulationSpeed
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
  /** Simulated weather for demo (dynamic context: "steep curves may be slippery in rain"). */
  const [weatherSim, setWeatherSim] = useState<"clear" | "rain" | "snow">("clear")
  /** True when current route is the alternate (scenic) so copilot can say "this route is poorly lit". */
  const [isAlternateRoute, setIsAlternateRoute] = useState(false)
  /** When set, show modal to pick between two routes with tradeoff explainer. */
  const [alternateRouteOptions, setAlternateRouteOptions] = useState<{
    routeA: { path: { lat: number; lng: number }[]; steps: RouteStep[]; durationMinutes: number; distanceKm: number }
    routeB: { path: { lat: number; lng: number }[]; steps: RouteStep[]; durationMinutes: number; distanceKm: number }
    tradeoffA: string
    tradeoffB: string
    destinationName?: string
    navigationMode?: "real" | "simulation"
  } | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const dragListenerRef = useRef<google.maps.MapsEventListener | null>(null)
  const lastPanTimeRef = useRef(0)
  const lastPanPositionRef = useRef<{ lat: number; lng: number } | null>(null)
  const userLocationRef = useRef<{ lat: number; lng: number } | null>(null)
  const zoomedToStartRef = useRef(false)
  userLocationRef.current = userLocation
  /** Set to true after we center the map on user location once on first load. Never center on GPS again after this. */
  const hasSetInitialCenterRef = useRef(false)
  /** Set to true as soon as we request (or get) initial location. GPS is then fully off — no more requests. */
  const hasRequestedInitialLocationRef = useRef(false)
  const mapRef = useRef<google.maps.Map | null>(null)
  mapRef.current = map
  const navigationModeRef = useRef(navigationMode)
  navigationModeRef.current = navigationMode
  /** In simulation we pass a single stable object so GoogleMap never re-applies center (stops flicker to origin). */
  const simulationCenterStableRef = useRef<{ lat: number; lng: number }>({ ...defaultCenter })

  useEffect(() => {
    if (!isLoaded) return
    const t = setTimeout(() => setMapReady(true), 150)
    return () => clearTimeout(t)
  }, [isLoaded])

  // Get initial location once, then never use geolocation again (GPS fully off after this).
  useEffect(() => {
    if (!mapReady || typeof navigator === "undefined" || !navigator.geolocation) return
    if (hasRequestedInitialLocationRef.current) return
    hasRequestedInitialLocationRef.current = true
    setUserLocationError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords
        setUserLocation({
          lat: latitude,
          lng: longitude,
          accuracy: accuracy ?? 50,
        })
      },
      (err) => setUserLocationError(err.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }, [mapReady])

  // One-time only: center map on initial GPS location when we first have both map and userLocation. Never again after this. Skip if we're in active simulation.
  useEffect(() => {
    if (!map || !userLocation || hasSetInitialCenterRef.current) return
    if (isGoMode && navigationMode === "simulation") return
    hasSetInitialCenterRef.current = true
    map.setCenter(userLocation)
    map.setZoom(FOLLOW_ZOOM)
    setMapCenter(userLocation)
  }, [map, userLocation?.lat, userLocation?.lng, isGoMode, navigationMode])

  // When navigation starts, zoom to the start of the route (like Google/Apple Maps). Skip in simulation — RAF owns the camera.
  useEffect(() => {
    if (!isGoMode || path.length === 0 || navigationMode === "simulation") {
      zoomedToStartRef.current = false
      return
    }
    if (zoomedToStartRef.current) return
    const start = path[0]
    if (!start || !map) return
    zoomedToStartRef.current = true
    setMapCenter(start)
    map.panTo(start)
    map.setZoom(FOLLOW_ZOOM)
  }, [isGoMode, path, map, navigationMode])

  const onLoad = useCallback((mapInstance: google.maps.Map) => {
    setMap(mapInstance)
    const initialCenter = userLocationRef.current ?? defaultCenter
    mapInstance.setCenter(initialCenter)
    mapInstance.setZoom(FOLLOW_ZOOM)
    if (typeof google !== "undefined" && google.maps?.event) {
      google.maps.event.trigger(mapInstance, "resize")
    }
    dragListenerRef.current = google.maps.event.addListener(
      mapInstance,
      "dragend",
      () => {
        if (navigationModeRef.current === "simulation") return
        const c = mapInstance.getCenter()
        if (c) setMapCenter({ lat: c.lat(), lng: c.lng() })
      }
    )
    setTimeout(() => {
      if (typeof google !== "undefined" && google.maps?.event) {
        google.maps.event.trigger(mapInstance, "resize")
      }
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
    if (currentRoutePolylineRef.current) {
      currentRoutePolylineRef.current.setMap(null)
      currentRoutePolylineRef.current = null
    }
    setMap(null)
  }, [])

  // Single route polyline: remove any existing one, then create and add exactly one for the current path.
  // Include routeVersion so when we add a stop and replace the route, the line always redraws.
  useEffect(() => {
    const mapInstance = map
    const pathCoords = path.length > 0 ? path.map((p) => ({ lat: p.lat, lng: p.lng })) : []

    if (currentRoutePolylineRef.current != null) {
      currentRoutePolylineRef.current.setMap(null)
      currentRoutePolylineRef.current = null
    }

    if (pathCoords.length === 0 || !mapInstance || typeof google === "undefined") return

    const polyline = new google.maps.Polyline({
      path: pathCoords,
      geodesic: false,
      strokeColor: "#1a73e8",
      strokeOpacity: 0.9,
      strokeWeight: 5,
    })
    polyline.setMap(mapInstance)
    currentRoutePolylineRef.current = polyline

    return () => {
      if (currentRoutePolylineRef.current === polyline) {
        currentRoutePolylineRef.current.setMap(null)
        currentRoutePolylineRef.current = null
      }
    }
  }, [map, path, routeVersion])

  // ——— Simulation: single imperative marker (create once, never re-mount) ———
  useEffect(() => {
    if (!map || !isGoMode || path.length === 0 || navigationMode !== "simulation") {
      if (carMarkerRef.current) {
        carMarkerRef.current.setMap(null)
        carMarkerRef.current = null
      }
      return
    }
    const start = path[0] ?? defaultCenter
    simulationCenterStableRef.current.lat = start.lat
    simulationCenterStableRef.current.lng = start.lng
    if (!carMarkerRef.current) {
      carMarkerRef.current = new google.maps.Marker({
        position: start,
        map,
        title: "Simulated location",
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 12,
          fillColor: "#007AFF",
          fillOpacity: 1,
          strokeColor: "#1e293b",
          strokeWeight: 2,
        },
      })
    } else {
      carMarkerRef.current.setPosition(start)
      carMarkerRef.current.setMap(map)
    }
    simCarIndexRef.current = 0
    segmentStartTimeRef.current = Date.now()
    simPositionRef.current = start
    setSimLocation(start)
    return () => {
      if (carMarkerRef.current) {
        carMarkerRef.current.setMap(null)
        carMarkerRef.current = null
      }
    }
  }, [map, isGoMode, path, navigationMode])

  // ——— Simulation: single RAF loop — advance segment, update marker + camera only via refs (zero re-renders) ———
  useEffect(() => {
    if (!isGoMode || path.length === 0 || navigationMode !== "simulation") {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return
    }
    if (isSimulationPaused) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      const idx = Math.min(carIndex, path.length - 1)
      const pos = path[idx] ?? null
      if (pos && carMarkerRef.current && mapRef.current) {
        carMarkerRef.current.setPosition(pos)
        mapRef.current.setCenter(pos)
        mapRef.current.setZoom(FOLLOW_ZOOM)
      }
      simPositionRef.current = pos
      setSimLocation(pos)
      return
    }
    const animate = () => {
      const pathSeg = pathRef.current
      const idx = simCarIndexRef.current
      const now = Date.now()
      const elapsed = now - segmentStartTimeRef.current
      const intervalMs = SIMULATION_INTERVAL_MS / Math.max(SIMULATION_SPEED_MIN, Math.min(SIMULATION_SPEED_MAX, simulationSpeedRef.current))
      const t = Math.min(1, elapsed / intervalMs)
      const i = Math.min(idx, pathSeg.length - 1)
      const nextI = Math.min(idx + 1, pathSeg.length - 1)
      let pos: { lat: number; lng: number }
      if (i >= pathSeg.length - 1) {
        pos = pathSeg[pathSeg.length - 1] ?? pathSeg[0] ?? defaultCenter
      } else {
        pos = lerp(pathSeg[i], pathSeg[nextI], t)
      }
      simPositionRef.current = pos
      carMarkerRef.current?.setPosition(pos)
      if (mapRef.current) {
        mapRef.current.setCenter(pos)
        mapRef.current.setZoom(FOLLOW_ZOOM)
      }
      if (t >= 1 && nextI < pathSeg.length) {
        simCarIndexRef.current = nextI
        segmentStartTimeRef.current = Date.now()
        tickCar()
      }
      const tNow = Date.now()
      if (tNow - lastSimLocationStateUpdateRef.current >= 500) {
        lastSimLocationStateUpdateRef.current = tNow
        setSimLocation(pos)
      }
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [isGoMode, path.length, path, carIndex, isSimulationPaused, navigationMode, tickCar])

  // Sync simCarIndexRef from context when path or carIndex changes (e.g. new route or external tick)
  useEffect(() => {
    if (isGoMode && path.length > 0 && navigationMode === "simulation") {
      simCarIndexRef.current = carIndex
      segmentStartTimeRef.current = Date.now()
    } else {
      setSimLocation(null)
    }
  }, [carIndex, isGoMode, path.length, navigationMode])

  // Nearby POIs for copilot — in simulation use only simLocation (single source); real mode uses smooth/car position
  const positionForPOIs = isGoMode
    ? (navigationMode === "simulation" ? simLocation : (smoothCarPosition ?? carPosition))
    : userLocation
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
    // In simulation, center is driven only by the center prop (effectiveMapCenter); do not call panTo to avoid fighting with it and causing jitter.
    if (navigationMode === "simulation") return
    const pos = carPosition
    if (!pos) return
    const now = Date.now()
    const lastPos = lastPanPositionRef.current
    const distM = lastPos ? distanceMeters(lastPos, pos) : 999
    const throttle = lastPos && distM < 10 && now - lastPanTimeRef.current < 120
    if (throttle) return
    lastPanTimeRef.current = now
    lastPanPositionRef.current = pos
    map.panTo(pos)
    map.setZoom(FOLLOW_ZOOM)
  }, [map, isGoMode, carPosition, path.length, isSimulationPaused, navigationMode])

  const effectiveMapCenter =
    isGoMode && path.length > 0
      ? navigationMode === "simulation"
        ? (path[0] ?? defaultCenter)
        : (smoothCarPosition ?? carPosition ?? mapCenter)
      : mapCenter

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
      if (searchForStartRef.current) {
        setStartPointNav(lat, lng)
        setStartPointAddress(address)
        setSearchForStartLocation(false)
        input.value = ""
        const dest = selectedDestRef.current
        if (dest) {
          fetchRouteAndSetPanel({ lat, lng }, { lat: dest.lat, lng: dest.lng }, dest.address, waypointsRef.current)
        }
        return
      }
      const isAddingStop = addingStopRef.current
      const isMidRoute = addingStopMidRouteRef.current
      if (isMidRoute) {
        input.value = ""
        setAddingStopMidRoute(false)
        const origin =
          navigationModeRef.current === "simulation"
            ? (simPositionRef.current ?? pathRef.current[0] ?? defaultCenter)
            : (carPositionRef.current ?? pathRef.current[0] ?? userLocation ?? defaultCenter)
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
              if (status === "OK" && result?.routes?.[0]?.legs?.length) {
                const { pathLatLng, steps, waypoints: routeWps } = buildPathStepsAndWaypointsFromRoute(result.routes[0])
                startNavigationWithPath(pathLatLng, destinationNameRef.current ?? undefined, steps, navigationMode, routeWps)
                setSelectedDestination(null)
                setWaypoints([])
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
        const origin = startPoint ?? userLocation ?? defaultCenter
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
        fetchRouteAndSetPanel(startPoint ?? userLocation ?? defaultCenter, { lat, lng }, address, [])
      }
    })
    autocompleteRef.current = ac
    return () => {
      google.maps.event.removeListener(listener)
      autocompleteRef.current = null
    }
  }, [isLoaded, mapReady, showSearchBar, navigationMode, startNavigationWithPath, startPoint])

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

  const mapOptions: google.maps.MapOptions =
    isGoMode && path.length > 0 && navigationMode === "simulation"
      ? { ...mapOptionsBase }
      : { ...mapOptionsBase, center: mapCenter }

  /** Use position-based index so chime and current step reflect sim position (updates with simLocation every 500ms). */
  const effectiveIndexForChime =
    isGoMode && path.length > 0
      ? navigationMode === "simulation" && (simLocation ?? path[0])
        ? closestPathIndex(path, (simLocation ?? path[0]).lat, (simLocation ?? path[0]).lng)
        : carIndex
      : 0
  const nextStep: RouteStep | null =
    routeSteps.find((s) => s.pathIndex > effectiveIndexForChime) ?? null
  const distanceToNextTurn =
    nextStep != null
      ? pathSegmentDistance(path, effectiveIndexForChime, nextStep.pathIndex)
      : null
  const arrived = carIndex >= path.length - 1

  /** Proactive chime: only for highway exit/merge—"Get in the right/left lane to exit/merge" when within 1 km. One per step. */
  const proactiveChimeText =
    isGoMode &&
    path.length > 0 &&
    nextStep &&
    distanceToNextTurn != null &&
    distanceToNextTurn <= LANE_CHIME_DISTANCE_M &&
    isMajorRoadStep(nextStep.instructionText)
      ? getChimePhrase(nextStep)
      : null
  const proactiveChimePathIndex =
    proactiveChimeText ? nextStep!.pathIndex : null
  /** "Turn left here" / "Take the exit now" when 50–150m from the turn; one per maneuver. Not when closer (avoids speaking while turning). */
  const proactiveChimeAtTurnText =
    isGoMode &&
    path.length > 0 &&
    nextStep &&
    distanceToNextTurn != null &&
    distanceToNextTurn >= PROACTIVE_CHIME_AT_TURN_MIN_DISTANCE_M &&
    distanceToNextTurn <= PROACTIVE_CHIME_AT_TURN_DISTANCE_M
      ? getChimePhraseAtTurn(nextStep)
      : null
  const proactiveChimeAtTurnPathIndex =
    proactiveChimeAtTurnText ? nextStep!.pathIndex : null

  /** Current step = step that contains our position (largest pathIndex <= effective index). Avoids always returning the first step (20th St). */
  const effectiveIndexForCurrentStep = isGoMode && path.length > 0 ? effectiveIndexForChime : carIndex
  const currentStepText =
    (routeSteps
      .filter((s) => s.pathIndex <= effectiveIndexForCurrentStep)
      .reduce<RouteStep | null>((best, s) => (best === null || s.pathIndex >= best.pathIndex ? s : best), null)
      ?.instructionText) ?? undefined
  const positionForContext = navigationMode === "simulation"
    ? (simLocation ?? path[0] ?? defaultCenter)
    : (smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter)
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
    distanceToNextTurnMeters: distanceToNextTurn ?? null,
    destinationName: destinationName ?? undefined,
    hasActiveRoute: isGoMode && path.length > 0,
    navigationMode: isGoMode ? navigationMode : undefined,
    heading,
    nearbyPOIs: nearbyPOIsWithSide.length > 0 ? nearbyPOIsWithSide : undefined,
    addStopOptions: searchResultsAddStopMode && searchNearbyResults.length > 0 ? searchNearbyResults : undefined,
    timeOfDay: (() => {
      const h = typeof window !== "undefined" ? new Date().getHours() : 12
      if (h >= 5 && h < 12) return "morning"
      if (h >= 12 && h < 17) return "afternoon"
      if (h >= 17 && h < 21) return "evening"
      return "night"
    })(),
    weatherSim: weatherSim !== "clear" ? weatherSim : undefined,
    isAlternateRoute: isGoMode && isAlternateRoute,
  }

  const handleAddStopWithQuery = useCallback(
    (query: string, _maxMinutesAdded?: number, _maxMinutesFromNow?: number) => {
      const origin =
        navigationMode === "simulation"
          ? (simLocation ?? path[0] ?? defaultCenter)
          : (smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter)
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
        const withCoords = results.slice(0, 8).map((p) => ({
          name: p.name ?? "Unnamed",
          address: p.formatted_address,
          lat: p.geometry?.location?.lat() ?? 0,
          lng: p.geometry?.location?.lng() ?? 0,
        }))
        const sorted = [...withCoords].sort(
          (a, b) => distanceMeters(origin, a) - distanceMeters(origin, b)
        )
        setSearchNearbyResults(sorted)
        setSearchResultsAddStopMode(true)
      })
    },
    [map, isGoMode, path, navigationMode, simLocation, smoothCarPosition, carPosition, userLocation]
  )

  /** Add a place as a waypoint: re-route through it (when navigating) or add to waypoints and refresh route (when planning). */
  const addPlaceAsStop = useCallback(
    (place: { name: string; address?: string; lat: number; lng: number }) => {
      const origin =
        navigationMode === "simulation"
          ? (simLocation ?? path[0] ?? defaultCenter)
          : (smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter)
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
            if (status !== "OK" || !result?.routes?.[0]?.legs?.length) return
            const { pathLatLng, steps, waypoints: waypointsFromLegs } = buildPathStepsAndWaypointsFromRoute(result.routes[0])
            setIsSimulationPaused(false)
            startNavigationWithPath(pathLatLng, destinationName ?? undefined, steps, navigationMode, waypointsFromLegs)
            setIsAlternateRoute(false)
            setSelectedDestination(null)
            setWaypoints([])
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

  /** Add a specific place as a stop immediately (e.g. voice: "choose one that has diesel" → Royal Gas). */
  const handleAddStopPlace = useCallback(
    (name: string, address: string, lat: number, lng: number) => {
      addPlaceAsStop({ name, address, lat, lng })
    },
    [addPlaceAsStop]
  )

  /** Show the add-stop list with exactly these places (e.g. Royal Gas, Shell, ARCO near Palega). */
  const handleShowAddStopOptions = useCallback(
    (places: { name: string; address?: string; lat: number; lng: number }[]) => {
      setSearchNearbyResults(places)
      setSearchResultsAddStopMode(true)
    },
    []
  )

  const handleRequestAlternateRoute = useCallback(() => {
    const origin =
      navigationMode === "simulation"
        ? (simLocation ?? path[0] ?? defaultCenter)
        : (smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter)
    const dest = destination ?? (path.length > 0 ? path[path.length - 1] : null)
    if (!dest || typeof google === "undefined" || !google.maps?.DirectionsService) return
    const ds = new google.maps.DirectionsService()
    const originLatLng = new google.maps.LatLng(origin.lat, origin.lng)
    const destLatLng = new google.maps.LatLng(dest.lat, dest.lng)
    const buildSteps = (route: google.maps.DirectionsRoute, pathLatLng: { lat: number; lng: number }[]) => {
      const steps: RouteStep[] = []
      ;(route.legs ?? []).forEach((leg: google.maps.DirectionsLeg) => {
        ;(leg.steps ?? []).forEach((s: google.maps.DirectionsStep) => {
          steps.push({
            instructionText: s.instructions ? stripHtml(s.instructions) : "Continue",
            pathIndex: s.start_location
              ? closestPathIndex(pathLatLng, s.start_location.lat(), s.start_location.lng())
              : 0,
          })
        })
      })
      return steps
    }
    const durDist = (route: google.maps.DirectionsRoute) => {
      let dur = 0
      let dist = 0
      ;(route.legs ?? []).forEach((leg: google.maps.DirectionsLeg) => {
        dur += leg.duration?.value ?? 0
        dist += leg.distance?.value ?? 0
      })
      return { durationMinutes: Math.ceil(dur / 60), distanceKm: (dist / 1000).toFixed(1) }
    }
    const applyAlternates = async (r0: google.maps.DirectionsRoute | null, r1: google.maps.DirectionsRoute | null) => {
      if (!r0?.overview_path?.length) return
      const pathA = r0.overview_path.map((p: google.maps.LatLng) => ({ lat: p.lat(), lng: p.lng() }))
      const stepsA = buildSteps(r0, pathA)
      const dA = durDist(r0)
      if (r1?.overview_path?.length) {
        const pathB = r1.overview_path.map((p: google.maps.LatLng) => ({ lat: p.lat(), lng: p.lng() }))
        const stepsB = buildSteps(r1, pathB)
        const dB = durDist(r1)
        try {
          const tradeoffRes = await fetch("/api/route-tradeoff", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              routeA: { durationMinutes: dA.durationMinutes, distanceKm: dA.distanceKm },
              routeB: { durationMinutes: dB.durationMinutes, distanceKm: dB.distanceKm },
              vibeA: "Fastest",
              vibeB: "Scenic",
            }),
          })
          const { tradeoffA, tradeoffB } = (await tradeoffRes.json()) as { tradeoffA: string; tradeoffB: string }
          setAlternateRouteOptions({
            routeA: { path: pathA, steps: stepsA, durationMinutes: dA.durationMinutes, distanceKm: parseFloat(dA.distanceKm) },
            routeB: { path: pathB, steps: stepsB, durationMinutes: dB.durationMinutes, distanceKm: parseFloat(dB.distanceKm) },
            tradeoffA: tradeoffA ?? "Faster route.",
            tradeoffB: tradeoffB ?? "Scenic alternate.",
            destinationName: destinationName ?? undefined,
            navigationMode,
          })
        } catch {
          setAlternateRouteOptions({
            routeA: { path: pathA, steps: stepsA, durationMinutes: dA.durationMinutes, distanceKm: parseFloat(dA.distanceKm) },
            routeB: { path: pathB, steps: stepsB, durationMinutes: dB.durationMinutes, distanceKm: parseFloat(dB.distanceKm) },
            tradeoffA: "Faster route.",
            tradeoffB: "Scenic alternate with different roads.",
            destinationName: destinationName ?? undefined,
            navigationMode,
          })
        }
      } else {
        ds.route(
          { origin: originLatLng, destination: destLatLng, travelMode: google.maps.TravelMode.DRIVING, provideRouteAlternatives: true },
          (altResult, altStatus) => {
            if (altStatus === "OK" && altResult?.routes?.length >= 2 && altResult.routes[1]?.overview_path?.length) {
              const r1 = altResult.routes[1]
              const pathB = r1.overview_path!.map((p: google.maps.LatLng) => ({ lat: p.lat(), lng: p.lng() }))
              const stepsB = buildSteps(r1, pathB)
              const dB = durDist(r1)
              setAlternateRouteOptions({
                routeA: { path: pathA, steps: stepsA, durationMinutes: dA.durationMinutes, distanceKm: parseFloat(dA.distanceKm) },
                routeB: { path: pathB, steps: stepsB, durationMinutes: dB.durationMinutes, distanceKm: parseFloat(dB.distanceKm) },
                tradeoffA: "Faster route.",
                tradeoffB: "Scenic alternate with different roads.",
                destinationName: destinationName ?? undefined,
                navigationMode,
              })
            }
          }
        )
      }
    }
    ds.route(
      { origin: originLatLng, destination: destLatLng, travelMode: google.maps.TravelMode.DRIVING },
      (resultA, statusA) => {
        if (statusA !== "OK" || !resultA?.routes?.[0]?.overview_path?.length) return
        const r0 = resultA.routes[0]
        ds.route(
          {
            origin: originLatLng,
            destination: destLatLng,
            travelMode: google.maps.TravelMode.DRIVING,
            avoid: ["highways"],
          },
          (resultB, statusB) => {
            const r1 = statusB === "OK" && resultB?.routes?.[0]?.overview_path?.length ? resultB.routes[0] : null
            applyAlternates(r0, r1)
          }
        )
      }
    )
  }, [destination, path, destinationName, startNavigationWithPath, navigationMode, simLocation, smoothCarPosition, carPosition, userLocation])

  const handleNavigateTo = useCallback(
    (query: string) => {
      const origin = isGoMode
        ? (navigationMode === "simulation"
            ? (simLocation ?? path[0] ?? defaultCenter)
            : (smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter))
        : (userLocation ?? defaultCenter)
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
        const routeOrigin = startPoint ?? userLocation ?? defaultCenter
        const ds = new google.maps.DirectionsService()
        ds.route(
          {
            origin: new google.maps.LatLng(routeOrigin.lat, routeOrigin.lng),
            destination: new google.maps.LatLng(lat, lng),
            travelMode: google.maps.TravelMode.DRIVING,
          },
          (result, routeStatus) => {
            if (routeStatus !== "OK" || !result?.routes?.[0]?.overview_path?.length) return
            const leg = result.routes[0].legs?.[0]
            const pathLatLng = result.routes[0].overview_path.map((pt: google.maps.LatLng) => ({
              lat: pt.lat(),
              lng: pt.lng(),
            }))
            const legs = result.routes[0].legs ?? []
            const steps: RouteStep[] = []
            legs.forEach((legItem: google.maps.DirectionsLeg) => {
              ;(legItem.steps ?? []).forEach((s: google.maps.DirectionsStep) => {
                steps.push({
                  instructionText: s.instructions ? stripHtml(s.instructions) : "Continue",
                  pathIndex: s.start_location
                    ? closestPathIndex(pathLatLng, s.start_location.lat(), s.start_location.lng())
                    : 0,
                })
              })
            })
            const durationMinutes = leg?.duration?.value ? Math.ceil(leg.duration.value / 60) : 0
            const stepsText = (leg?.steps ?? [])
              .map((s: google.maps.DirectionsStep) => (s.instructions ? stripHtml(s.instructions) : ""))
              .filter(Boolean)
            setSelectedDestination({
              lat,
              lng,
              address: destName,
              durationMinutes,
              steps: stepsText,
            })
          }
        )
      })
    },
    [map, userLocation, startNavigationWithPath, isGoMode, smoothCarPosition, carPosition, startPoint]
  )

  /** Navigate to a specific place by coords (e.g. after user picks from search_nearby results). */
  const handleNavigateToPlace = useCallback(
    (lat: number, lng: number, destName: string) => {
      const origin = isGoMode
        ? (navigationMode === "simulation"
            ? (simLocation ?? path[0] ?? defaultCenter)
            : (smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter))
        : (userLocation ?? defaultCenter)
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
          setIsAlternateRoute(false)
        }
      )
    },
    [map, userLocation, startNavigationWithPath, isGoMode, smoothCarPosition, carPosition]
  )

  /** "Vegetarian options near me" etc.: run Places search near user, show results for user to pick. */
  const handleSearchNearby = useCallback(
    (query: string) => {
      setSearchResultsAddStopMode(false)
      const origin = isGoMode
        ? (navigationMode === "simulation"
            ? (simLocation ?? path[0] ?? defaultCenter)
            : (smoothCarPosition ?? carPosition ?? userLocation ?? defaultCenter))
        : (userLocation ?? defaultCenter)
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
    [map, userLocation, isGoMode, smoothCarPosition, carPosition]
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
      className="relative w-full overflow-visible bg-zinc-950"
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
              searchForStartLocation
                ? "Search start location..."
                : addingStopMidRoute
                ? "Search for a place to add (you’ll go there next)..."
                : addingStop
                  ? "Search for a place to add as stop..."
                  : "Search destination or place..."
            }
            className="flex-1 rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            aria-label="Search destination or place"
          />
          {(addingStop || addingStopMidRoute || searchForStartLocation) && (
            <button
              type="button"
              onClick={() => {
                setAddingStop(false)
                setAddingStopMidRoute(false)
                setSearchForStartLocation(false)
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
          center={
            isGoMode && path.length > 0 && navigationMode === "simulation"
              ? undefined
              : effectiveMapCenter
          }
          zoom={FOLLOW_ZOOM}
          onLoad={onLoad}
          onUnmount={onUnmount}
          onClick={(e) => {
            if (e.latLng) {
              const lat = e.latLng.lat()
              const lng = e.latLng.lng()
              const origin = startPoint ?? userLocation ?? defaultCenter
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
          {selectedDestination && !isGoMode && (
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
          {!isGoMode && waypoints.map((wp, i) => (
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
          {isGoMode && navigationMode === "real" && carPosition && (
            <Marker
              position={carPosition}
              title="Your location"
              icon={{
                path: google.maps.SymbolPath.CIRCLE,
                scale: 12,
                fillColor: "#007AFF",
                fillOpacity: 1,
                strokeColor: "#1e293b",
                strokeWeight: 2,
              }}
            />
          )}
          {routeWaypoints.map((wp, i) => (
            <Marker
              key={`waypoint-${i}`}
              position={{ lat: wp.lat, lng: wp.lng }}
              title={wp.name ?? `Stop ${i + 1}`}
            />
          ))}
          {destination && (
            <Marker
              position={destination}
              title="Destination"
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
        <div className="absolute bottom-0 left-0 right-0 z-20 max-h-[55vh] overflow-y-auto rounded-t-2xl border border-zinc-700 bg-zinc-900 px-4 py-4 shadow-[0_-4px_20px_rgba(0,0,0,0.4)]">
          <p className="font-semibold text-zinc-100">
            {selectedDestination.address}
          </p>
          <p className="mt-0.5 text-sm text-zinc-400">
            {selectedDestination.durationMinutes > 0
              ? `~${selectedDestination.durationMinutes} min total`
              : "Getting route…"}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-700 pt-3">
            <span className="text-xs text-zinc-500">Start from:</span>
            <span className="text-sm text-zinc-300">
              {startPointAddress ?? "Current location"}
            </span>
            <button
              type="button"
              onClick={() => {
                setSearchForStartLocation(true)
                setTimeout(() => searchInputRef.current?.focus(), 100)
              }}
              className="rounded bg-zinc-700 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-600"
            >
              Change
            </button>
            {startPoint && (
              <button
                type="button"
                onClick={() => {
                  clearStartPoint()
                  setStartPointAddress(null)
                  if (selectedDestination) {
                    fetchRouteAndSetPanel(
                      userLocation ?? defaultCenter,
                      { lat: selectedDestination.lat, lng: selectedDestination.lng },
                      selectedDestination.address,
                      waypoints
                    )
                  }
                }}
                className="rounded bg-zinc-700 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-600"
              >
                Use current location
              </button>
            )}
          </div>

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
                const origin = startPoint ?? userLocation ?? defaultCenter
                const dest = {
                  lat: selectedDestination.lat,
                  lng: selectedDestination.lng,
                }
                const destName = selectedDestination.address
                setIsAlternateRoute(false)
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
                          result?.routes?.[0]?.legs?.length
                        ) {
                          const { pathLatLng, steps, waypoints: routeWps } = buildPathStepsAndWaypointsFromRoute(result.routes[0])
                          setIsSimulationPaused(false)
                          startNavigationWithPath(pathLatLng, destName, steps, mode, routeWps)
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
                const origin = startPoint ?? userLocation ?? defaultCenter
                const dest = {
                  lat: selectedDestination.lat,
                  lng: selectedDestination.lng,
                }
                const destName = selectedDestination.address
                setIsAlternateRoute(false)
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
                          result?.routes?.[0]?.legs?.length
                        ) {
                          const { pathLatLng, steps, waypoints: routeWps } = buildPathStepsAndWaypointsFromRoute(result.routes[0])
                          setIsSimulationPaused(false)
                          startNavigationWithPath(pathLatLng, destName, steps, mode, routeWps)
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
        <div
          className="absolute left-0 right-0 z-[90] flex items-center justify-between gap-4 rounded-t-2xl border-t border-zinc-200 bg-white pl-8 pr-4 py-4 shadow-[0_-4px_20px_rgba(0,0,0,0.15)] dark:border-zinc-700 dark:bg-zinc-900"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
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
            <>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-zinc-500 dark:text-zinc-400" title="Simulation speed">Speed</span>
                <input
                  type="range"
                  min={SIMULATION_SPEED_MIN}
                  max={SIMULATION_SPEED_MAX}
                  step={0.25}
                  value={simulationSpeed}
                  onChange={(e) => setSimulationSpeed(parseFloat(e.target.value))}
                  className="h-2 w-20 accent-cyan-500 dark:accent-cyan-400"
                  aria-label="Simulation speed"
                />
                <span className="min-w-[2.5rem] text-xs text-zinc-400 dark:text-zinc-500">
                  {simulationSpeed === 1 ? "1×" : `${simulationSpeed}×`}
                </span>
              </div>
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
            </>
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
        proactiveChimeText={proactiveChimeText}
        proactiveChimePathIndex={proactiveChimePathIndex}
        proactiveChimeAtTurnText={proactiveChimeAtTurnText}
        proactiveChimeAtTurnPathIndex={proactiveChimeAtTurnPathIndex}
        onAddStopWithQuery={handleAddStopWithQuery}
        onAddStopPlace={handleAddStopPlace}
        onRequestAlternateRoute={handleRequestAlternateRoute}
        onNavigateTo={handleNavigateTo}
        onSearchNearby={handleSearchNearby}
        onShowAddStopOptions={handleShowAddStopOptions}
        onPickOption={handlePickOption}
      />

      {/* Alternate route picker with tradeoff explainer */}
      {alternateRouteOptions && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label="Choose route">
          <div className="w-full max-w-md rounded-2xl border border-zinc-600 bg-zinc-900 p-5 shadow-xl">
            <h3 className="mb-3 text-lg font-semibold text-zinc-100">Choose your route</h3>
            <p className="mb-4 text-sm text-zinc-400">Pick one — Shotgun explains the tradeoff.</p>
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => {
                  startNavigationWithPath(
                    alternateRouteOptions.routeA.path,
                    alternateRouteOptions.destinationName ?? destinationName ?? undefined,
                    alternateRouteOptions.routeA.steps,
                    alternateRouteOptions.navigationMode ?? navigationMode
                  )
                  setIsAlternateRoute(false)
                  setAlternateRouteOptions(null)
                }}
                className="w-full rounded-xl border border-zinc-600 bg-zinc-800 p-4 text-left transition hover:border-cyan-500 hover:bg-zinc-700"
              >
                <span className="font-medium text-cyan-300">Route A</span>
                <span className="ml-2 text-zinc-400">
                  {alternateRouteOptions.routeA.durationMinutes} min · {alternateRouteOptions.routeA.distanceKm.toFixed(1)} km
                </span>
                <p className="mt-1.5 text-sm text-zinc-300">{alternateRouteOptions.tradeoffA}</p>
              </button>
              <button
                type="button"
                onClick={() => {
                  startNavigationWithPath(
                    alternateRouteOptions.routeB.path,
                    alternateRouteOptions.destinationName ?? destinationName ?? undefined,
                    alternateRouteOptions.routeB.steps,
                    alternateRouteOptions.navigationMode ?? navigationMode
                  )
                  setIsAlternateRoute(true)
                  setAlternateRouteOptions(null)
                }}
                className="w-full rounded-xl border border-zinc-600 bg-zinc-800 p-4 text-left transition hover:border-cyan-500 hover:bg-zinc-700"
              >
                <span className="font-medium text-amber-300">Route B (Scenic)</span>
                <span className="ml-2 text-zinc-400">
                  {alternateRouteOptions.routeB.durationMinutes} min · {alternateRouteOptions.routeB.distanceKm.toFixed(1)} km
                </span>
                <p className="mt-1.5 text-sm text-zinc-300">{alternateRouteOptions.tradeoffB}</p>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setAlternateRouteOptions(null)}
              className="mt-4 w-full rounded-lg bg-zinc-700 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-600"
            >
              Keep current route
            </button>
          </div>
        </div>
      )}

      {/* Demo: simulated weather for context-aware messages (e.g. "steep curves may be slippery") */}
      {isGoMode && (
        <div className="absolute left-4 top-20 z-20 flex items-center gap-2 rounded-lg border border-zinc-600 bg-zinc-900/95 px-2 py-1.5 text-xs backdrop-blur">
          <span className="text-zinc-500">Weather (demo):</span>
          <select
            value={weatherSim}
            onChange={(e) => setWeatherSim(e.target.value as "clear" | "rain" | "snow")}
            className="rounded border border-zinc-600 bg-zinc-800 text-zinc-200"
          >
            <option value="clear">Clear</option>
            <option value="rain">Rain</option>
            <option value="snow">Snow</option>
          </select>
        </div>
      )}
    </div>
  )
}
