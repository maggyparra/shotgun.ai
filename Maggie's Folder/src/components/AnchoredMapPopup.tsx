"use client"

import { useEffect, useRef } from "react"
import { useGoogleMap } from "@react-google-maps/api"

const POPUP_STYLES = `
  padding: 1rem 1.5rem;
  border-radius: 1rem;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(0,0,0,0.75);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
  max-width: min(340px, calc(100vw - 2rem));
  text-align: center;
  color: white;
  font-family: system-ui, -apple-system, sans-serif;
`
const ADDRESS_STYLES = "font-size: 1.125rem; font-weight: 600; line-height: 1.4; text-shadow: 0 1px 2px rgba(0,0,0,0.3);"
const LINK_STYLES = "display: block; margin-top: 0.75rem; font-size: 1rem; font-weight: 500; color: #7dd3fc; text-decoration: none;"

/**
 * Custom overlay that anchors a black stained glass popup to a lat/lng on the map.
 * The popup moves with the map when the user pans or zooms.
 */
export function AnchoredMapPopup({
  position,
  address,
  googleMapsUrl,
}: {
  position: { lat: number; lng: number }
  address: string
  googleMapsUrl: string
}) {
  const map = useGoogleMap()
  const overlayRef = useRef<google.maps.OverlayView | null>(null)

  useEffect(() => {
    if (!map || typeof google === "undefined") return

    class PopupOverlay extends google.maps.OverlayView {
      position: google.maps.LatLng
      containerDiv: HTMLDivElement
      constructor(
        pos: google.maps.LatLngLiteral,
        addr: string,
        url: string
      ) {
        super()
        this.position = new google.maps.LatLng(pos.lat, pos.lng)
        this.containerDiv = document.createElement("div")
        this.containerDiv.style.cssText = "position:absolute;pointer-events:auto;z-index:10;"
        this.containerDiv.innerHTML = `
          <div style="${POPUP_STYLES}">
            <p style="${ADDRESS_STYLES}">${addr.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
            <a href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer" style="${LINK_STYLES}">View on Google Maps</a>
          </div>
        `
      }

      onAdd() {
        const panes = this.getPanes()
        if (panes?.floatPane) {
          panes.floatPane.appendChild(this.containerDiv)
        }
      }

      draw() {
        if (!this.getProjection()) return
        const point = this.getProjection()!.fromLatLngToDivPixel(this.position)
        if (!point) return
        this.containerDiv.style.left = point.x + "px"
        this.containerDiv.style.top = point.y + "px"
        this.containerDiv.style.transform = "translate(-50%, calc(-100% - 45px))"
      }

      onRemove() {
        if (this.containerDiv.parentNode) {
          this.containerDiv.parentNode.removeChild(this.containerDiv)
        }
      }
    }

    const overlay = new PopupOverlay(position, address, googleMapsUrl)
    overlay.setMap(map)
    overlayRef.current = overlay

    return () => {
      overlay.setMap(null)
      overlayRef.current = null
    }
  }, [map, position.lat, position.lng, address, googleMapsUrl])

  return null
}
