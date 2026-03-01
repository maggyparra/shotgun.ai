"use client"

import { useEffect, useRef } from "react"
import { useGoogleMap } from "@react-google-maps/api"

const IOS_LOCATION_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='6' fill='%23007AFF'/%3E%3Ccircle cx='12' cy='12' r='2' fill='white'/%3E%3C/svg%3E"

/**
 * Car marker as a custom OverlayView — updates position imperatively without React re-renders.
 * Uses requestAnimationFrame to move smoothly and avoids map/screen glitching.
 */
export function CarMarkerOverlay({
  positionRef,
  visible,
}: {
  positionRef: React.MutableRefObject<{ lat: number; lng: number } | null>
  visible: boolean
}) {
  const map = useGoogleMap()
  const overlayRef = useRef<google.maps.OverlayView | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!map || typeof google === "undefined") return

    class CarOverlay extends google.maps.OverlayView {
      positionRef: React.MutableRefObject<{ lat: number; lng: number } | null>
      div: HTMLDivElement
      constructor(posRef: React.MutableRefObject<{ lat: number; lng: number } | null>) {
        super()
        this.positionRef = posRef
        this.div = document.createElement("div")
        this.div.style.cssText =
          "position:absolute;pointer-events:none;z-index:10;width:36px;height:36px;margin-left:-18px;margin-top:-18px;"
        this.div.innerHTML = `<img src="${IOS_LOCATION_ICON}" alt="" style="width:100%;height:100%;" />`
      }
      onAdd() {
        const panes = this.getPanes()
        if (panes?.floatPane) panes.floatPane.appendChild(this.div)
      }
      draw() {
        const pos = this.positionRef.current
        if (!pos || !this.getProjection()) return
        const point = this.getProjection()!.fromLatLngToDivPixel(new google.maps.LatLng(pos.lat, pos.lng))
        if (!point) return
        this.div.style.left = point.x + "px"
        this.div.style.top = point.y + "px"
      }
      onRemove() {
        if (this.div.parentNode) this.div.parentNode.removeChild(this.div)
      }
    }

    const overlay = new CarOverlay(positionRef)
    overlay.setMap(map)
    overlayRef.current = overlay

    const animate = () => {
      if (overlayRef.current && overlayRef.current.getProjection()) {
        overlayRef.current.draw()
      }
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      overlay.setMap(null)
      overlayRef.current = null
    }
  }, [map, positionRef])

  useEffect(() => {
    const overlay = overlayRef.current as unknown as { div?: HTMLElement } | null
    if (overlay?.div) overlay.div.style.display = visible ? "" : "none"
  }, [visible])

  return null
}
