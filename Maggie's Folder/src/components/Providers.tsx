"use client"

/**
 * Client-side providers: Convex + Navigation.
 * Ensures Convex and Navigation state are available to the Map and voice UI.
 */

import { ConvexProvider, ConvexReactClient } from "convex/react"
import { NavigationProvider } from "@/context/NavigationContext"

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
if (!convexUrl) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL is required")
}
const convex = new ConvexReactClient(convexUrl)

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConvexProvider client={convex}>
      <NavigationProvider>{children}</NavigationProvider>
    </ConvexProvider>
  )
}
