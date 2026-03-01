"use client"

import { ConvexProvider, ConvexReactClient } from "convex/react"
import { NavigationProvider } from "@/context/NavigationContext"

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null

export function Providers({ children }: { children: React.ReactNode }) {
  if (!convex) {
    return (
      <div className="grid min-h-screen place-items-center p-4 text-center">
        <div className="max-w-md rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900">
          <p className="font-semibold">Convex URL required</p>
          <p className="mt-2 text-sm">
            Add <code className="rounded bg-amber-100 px-1">NEXT_PUBLIC_CONVEX_URL</code> to a{" "}
            <code className="rounded bg-amber-100 px-1">.env.local</code> file in John&apos;s Folder, then restart the dev server.
          </p>
          <p className="mt-2 text-sm">Get the URL from Maggie or run <code className="rounded bg-amber-100 px-1">npx convex dev</code> to create one.</p>
        </div>
      </div>
    )
  }
  return (
    <ConvexProvider client={convex}>
      <NavigationProvider>{children}</NavigationProvider>
    </ConvexProvider>
  )
}
