"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { snapToPath } from "@/lib/pathUtils"

export type LatLng = { lat: number; lng: number }

/** One turn-by-turn step: instruction text + index into path where it applies */
export type RouteStep = {
  instructionText: string
  pathIndex: number
}

export type NavigationState = {
  isGoMode: boolean
  /** 'real' = use GPS, position snaps to path; 'simulation' = tick-based dot along path */
  navigationMode: "real" | "simulation"
  path: LatLng[]
  carIndex: number
  carPosition: LatLng | null
  startPoint: LatLng | null
  destination: LatLng | null
  destinationName: string | null
  /** Turn-by-turn steps with path indices for banner + distance-to-turn */
  routeSteps: RouteStep[]
}

type NavigationActions = {
  setStartPoint: (lat: number, lng: number) => void
  setDestination: (lat: number, lng: number, name?: string) => void
  setPath: (path: LatLng[]) => void
  startGoMode: () => void
  /** Start navigation with path and steps; mode = 'real' (GPS) or 'simulation' (tick-based dot) */
  startNavigationWithPath: (
    path: LatLng[],
    destinationName?: string,
    steps?: RouteStep[],
    mode?: "real" | "simulation"
  ) => void
  stopGoMode: () => void
  setCarIndex: (index: number) => void
  tickCar: () => void
  /** In real mode: snap (lat,lng) to path and update carPosition/carIndex */
  updatePositionFromGps: (lat: number, lng: number) => void
}

const defaultState: NavigationState = {
  isGoMode: false,
  navigationMode: "simulation",
  path: [],
  carIndex: 0,
  carPosition: null,
  startPoint: null,
  destination: null,
  destinationName: null,
  routeSteps: [],
}

const NavigationContext = createContext<
  (NavigationState & NavigationActions) | null
>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NavigationState>(defaultState)

  const setStartPoint = useCallback((lat: number, lng: number) => {
    setState((s) => ({ ...s, startPoint: { lat, lng } }))
  }, [])

  const setDestination = useCallback(
    (lat: number, lng: number, name?: string) => {
      setState((s) => ({
        ...s,
        destination: { lat, lng },
        destinationName: name ?? null,
      }))
    },
    [],
  )

  const setPath = useCallback((path: LatLng[]) => {
    setState((s) => ({
      ...s,
      path,
      carIndex: 0,
      carPosition: path.length > 0 ? path[0] : null,
    }))
  }, [])

  const startGoMode = useCallback(() => {
    setState((s) => ({
      ...s,
      isGoMode: true,
      carPosition: s.path.length > 0 ? s.path[0] : null,
      carIndex: 0,
    }))
  }, [])

  const startNavigationWithPath = useCallback(
    (path: LatLng[], destinationName?: string, steps?: RouteStep[], mode: "real" | "simulation" = "simulation") => {
      if (path.length === 0) return
      const last = path[path.length - 1]
      setState((s) => ({
        ...s,
        isGoMode: true,
        navigationMode: mode,
        path,
        carIndex: 0,
        carPosition: path[0],
        destination: last,
        destinationName: destinationName ?? null,
        routeSteps: steps ?? [],
      }))
    },
    [],
  )

  const stopGoMode = useCallback(() => {
    setState((s) => ({ ...s, isGoMode: false }))
  }, [])

  const updatePositionFromGps = useCallback((lat: number, lng: number) => {
    setState((s) => {
      if (!s.isGoMode || s.path.length === 0 || s.navigationMode !== "real") return s
      const snapped = snapToPath(s.path, lat, lng)
      const idx = Math.min(snapped.pathIndex, s.path.length - 1)
      return {
        ...s,
        carIndex: idx,
        carPosition: snapped.position,
      }
    })
  }, [])

  const setCarIndex = useCallback((index: number) => {
    setState((s) => {
      const i = Math.max(0, Math.min(index, s.path.length - 1))
      return {
        ...s,
        carIndex: i,
        carPosition: s.path[i] ?? null,
      }
    })
  }, [])

  const tickCar = useCallback(() => {
    setState((s) => {
      if (!s.isGoMode || s.path.length === 0) return s
      const next = Math.min(s.carIndex + 1, s.path.length - 1)
      return {
        ...s,
        carIndex: next,
        carPosition: s.path[next] ?? null,
      }
    })
  }, [])

  const value = useMemo(
    () => ({
      ...state,
      setStartPoint,
      setDestination,
      setPath,
      startGoMode,
      startNavigationWithPath,
      stopGoMode,
      setCarIndex,
      tickCar,
      updatePositionFromGps,
    }),
    [
      state,
      setStartPoint,
      setDestination,
      setPath,
      startGoMode,
      startNavigationWithPath,
      stopGoMode,
      setCarIndex,
      tickCar,
      updatePositionFromGps,
    ],
  )

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  )
}

export function useNavigation() {
  const ctx = useContext(NavigationContext)
  if (!ctx) {
    throw new Error("useNavigation must be used within NavigationProvider")
  }
  return ctx
}
