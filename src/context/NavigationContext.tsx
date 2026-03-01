"use client"

/**
 * NavigationProvider — central state for GO mode, route, and car position.
 * Decoded polyline path drives the car marker; WE logic uses current position.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type LatLng = { lat: number; lng: number }

export type NavigationState = {
  /** Whether WE are in GO mode (simulating drive along route) */
  isGoMode: boolean
  /** Decoded route path (from Google polyline) */
  path: LatLng[]
  /** Index into path for current car position */
  carIndex: number
  /** Current car position; derived from path[carIndex] */
  carPosition: LatLng | null
  /** Start point set by user (click on map) */
  startPoint: LatLng | null
  /** Destination set by user/agent */
  destination: LatLng | null
  /** Human-readable destination name */
  destinationName: string | null
}

type NavigationActions = {
  setStartPoint: (lat: number, lng: number) => void
  setDestination: (lat: number, lng: number, name?: string) => void
  setPath: (path: LatLng[]) => void
  startGoMode: () => void
  /** Start GO mode with a path in one update so path + car + isGoMode are set together */
  startNavigationWithPath: (path: LatLng[], destinationName?: string) => void
  stopGoMode: () => void
  setCarIndex: (index: number) => void
  /** Advance car by one step along path (for simulation tick) */
  tickCar: () => void
}

const defaultState: NavigationState = {
  isGoMode: false,
  path: [],
  carIndex: 0,
  carPosition: null,
  startPoint: null,
  destination: null,
  destinationName: null,
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

  const startNavigationWithPath = useCallback((path: LatLng[], destinationName?: string) => {
    if (path.length === 0) return
    const last = path[path.length - 1]
    setState((s) => ({
      ...s,
      isGoMode: true,
      path,
      carIndex: 0,
      carPosition: path[0],
      destination: last,
      destinationName: destinationName ?? null,
    }))
  }, [])

  const stopGoMode = useCallback(() => {
    setState((s) => ({ ...s, isGoMode: false }))
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
