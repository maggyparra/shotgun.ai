export type CopilotContext = {
  position: { lat: number; lng: number }
  /** When on a route, destination coords for weather/context */
  destination?: { lat: number; lng: number }
  currentStepText?: string
  nextStepText?: string
  /** Distance in meters to the next turn/exit from current position. Lets copilot say "not this one" when next step is still far. */
  distanceToNextTurnMeters?: number | null
  destinationName?: string | null
  hasActiveRoute: boolean
  /** 'real' = GPS tracking; 'simulation' = simulated dot along route */
  navigationMode?: "real" | "simulation"
  heading?: number
  nearbyPOIs?: { name: string; types?: string[]; lat: number; lng: number; side?: "left" | "right"; distance_m?: number }[]
  /** When add-stop options panel is showing: list so user can say "pick the first option" */
  addStopOptions?: { name: string; address?: string; lat: number; lng: number }[]
  /** Time of day for context-aware suggestions (e.g. "this route is poorly lit at night"). */
  timeOfDay?: "morning" | "afternoon" | "evening" | "night"
  /** Simulated weather for demo (e.g. "rain" triggers "steep curves may be slippery"). */
  weatherSim?: "clear" | "rain" | "snow"
  /** When true, current route is the "alternate" (e.g. scenic) so copilot can say "this scenic route is poorly lit". */
  isAlternateRoute?: boolean
}

export type CopilotAction =
  | { type: "add_stop"; query: string; maxMinutesAdded?: number; maxMinutesFromNow?: number }
  | { type: "add_stop_place"; name: string; address: string; lat: number; lng: number }
  | { type: "add_stop_options"; places: { name: string; address?: string; lat: number; lng: number }[] }
  | { type: "pick_option"; index: number }
  | { type: "request_alternate_route" }
  | { type: "navigate_to"; query: string }
  | { type: "search_nearby"; query: string }
  | { type: "none" }
