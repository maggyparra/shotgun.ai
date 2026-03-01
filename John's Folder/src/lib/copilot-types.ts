export type CopilotContext = {
  position: { lat: number; lng: number }
  /** When on a route, destination coords for weather/context */
  destination?: { lat: number; lng: number }
  currentStepText?: string
  nextStepText?: string
  destinationName?: string | null
  hasActiveRoute: boolean
  /** 'real' = GPS tracking; 'simulation' = simulated dot along route */
  navigationMode?: "real" | "simulation"
  heading?: number
  nearbyPOIs?: { name: string; types?: string[]; lat: number; lng: number; side?: "left" | "right"; distance_m?: number }[]
  /** When add-stop options panel is showing: list so user can say "pick the first option" */
  addStopOptions?: { name: string; address?: string; lat: number; lng: number }[]
}

export type CopilotAction =
  | { type: "add_stop"; query: string; maxMinutesAdded?: number; maxMinutesFromNow?: number }
  | { type: "add_stop_place"; name: string; address: string; lat: number; lng: number }
  | { type: "pick_option"; index: number }
  | { type: "request_alternate_route" }
  | { type: "navigate_to"; query: string }
  | { type: "search_nearby"; query: string }
  | { type: "none" }
