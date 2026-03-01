/**
 * Convex stops: mutations and queries for Browser Use–discovered stops.
 */

import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const addStop = mutation({
  args: {
    label: v.string(),
    placeId: v.optional(v.string()),
    lat: v.number(),
    lng: v.number(),
    taskHint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("stops", {
      label: args.label,
      placeId: args.placeId,
      lat: args.lat,
      lng: args.lng,
      taskHint: args.taskHint,
      createdAt: Date.now(),
    })
  },
})

export const listStops = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("stops").collect()
    return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)
  },
})
