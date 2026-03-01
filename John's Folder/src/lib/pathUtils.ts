/** Distance in meters between two points (Haversine) */
export function distanceMeters(
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

/** Project point onto nearest path segment; return snapped position and segment end index */
export function snapToPath(
  path: { lat: number; lng: number }[],
  lat: number,
  lng: number
): { position: { lat: number; lng: number }; pathIndex: number } {
  if (path.length === 0) return { position: { lat, lng }, pathIndex: 0 }
  if (path.length === 1) return { position: path[0], pathIndex: 0 }
  const p = { lat, lng }
  let bestPos = path[0]
  let bestIdx = 0
  let bestD = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    const ax = b.lat - a.lat
    const ay = b.lng - a.lng
    const lenSq = ax * ax + ay * ay || 1
    const t = Math.max(0, Math.min(1, ((lat - a.lat) * ax + (lng - a.lng) * ay) / lenSq))
    const proj = { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) }
    const d = distanceMeters(p, proj)
    if (d < bestD) {
      bestD = d
      bestPos = proj
      bestIdx = t >= 0.5 ? i + 1 : i
    }
  }
  return { position: bestPos, pathIndex: bestIdx }
}
