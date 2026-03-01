/**
 * Convex schema for Shotgun.ai
 * Defines the stops table: reactive sync when Browser Use agent finds a stop
 */

import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  // Stops discovered by Browser Use agent; map UI reacts to these
  stops: defineTable({
    label: v.string(),
    placeId: v.optional(v.string()),
    lat: v.number(),
    lng: v.number(),
    taskHint: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),
})
