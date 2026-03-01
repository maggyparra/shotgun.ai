import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  stops: defineTable({
    label: v.string(),
    placeId: v.optional(v.string()),
    lat: v.number(),
    lng: v.number(),
    taskHint: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),
})
