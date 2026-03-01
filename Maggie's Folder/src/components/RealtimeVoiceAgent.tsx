"use client"

/**
 * Realtime Voice Agent — WebRTC to OpenAI Realtime API.
 * Handles propose_stop, confirm_add_stop, cancel_proposal tool calls.
 * Updates AgentContext for HUD status; triggers Convex mutations on confirm.
 */

import { useAction, useMutation } from "convex/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../../convex/_generated/api"
import { useAgent } from "@/context/AgentContext"
import { useNavigation } from "@/context/NavigationContext"

type RealtimeEvent = {
  type?: string
  item?: { type?: string; id?: string; name?: string; arguments?: string }
  item_id?: string
  output?: string
}

export function RealtimeVoiceAgent({ active }: { active: boolean }) {
  const { path, carPosition, destination, startNavigationWithPath } = useNavigation()
  const { setStatus, setPendingProposal, setError, clearProposal, getPendingProposalRef } = useAgent()
  const proposeStop = useAction(api.agent.proposeStop)
  const addStop = useMutation(api.stops.addStop)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [connected, setConnected] = useState(false)

  const handleFunctionCall = useCallback(
    async (name: string, args: string) => {
      try {
        if (name === "propose_stop") {
          setStatus("searching")
          const parsed = JSON.parse(args || "{}") as { location_name?: string; similar_category?: string }
          const loc = parsed.location_name ?? ""
          const origin = carPosition ?? (path[0] ?? { lat: 37.7592, lng: -122.418 })
          const dest = destination ?? path[path.length - 1] ?? { lat: 37.7592, lng: -122.418 }
          const result = await proposeStop({
            locationName: loc,
            similarCategory: parsed.similar_category,
            originLat: origin.lat,
            originLng: origin.lng,
            destLat: dest.lat,
            destLng: dest.lng,
          })
          setStatus("confirming")
          if (result.error) {
            setError(result.error)
            return JSON.stringify(result)
          }
          setPendingProposal({ name: result.name, lat: result.lat, lng: result.lng, time_added: result.time_added })
          return JSON.stringify({ name: result.name, lat: result.lat, lng: result.lng, time_added: result.time_added })
        }
        if (name === "confirm_add_stop") {
          const p = getPendingProposalRef().current
          if (p) {
            await addStop({ label: p.name, lat: p.lat, lng: p.lng })
            clearProposal()
            setStatus("idle")
            return "added"
          }
          return "no_pending"
        }
        if (name === "cancel_proposal") {
          clearProposal()
          return "cancelled"
        }
        return ""
      } catch (e) {
        setStatus("error")
        setError(String(e))
        return JSON.stringify({ error: String(e) })
      }
    },
    [carPosition, path, destination, proposeStop, addStop, setStatus, setPendingProposal, setError, clearProposal, getPendingProposalRef]
  )

  useEffect(() => {
    if (!active) {
      pcRef.current?.close()
      pcRef.current = null
      dcRef.current = null
      setConnected(false)
      setStatus("idle")
      return
    }

    let cancelled = false
    const run = async () => {
      try {
        setStatus("idle")
        const pc = new RTCPeerConnection()
        pcRef.current = pc
        const audioEl = document.createElement("audio")
        audioEl.autoplay = true
        audioRef.current = audioEl
        pc.ontrack = (e) => {
          if (audioEl.srcObject !== e.streams[0]) audioEl.srcObject = e.streams[0]
        }
        const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
        pc.addTrack(ms.getTracks()[0])
        const dc = pc.createDataChannel("oai-events")
        dcRef.current = dc
        dc.addEventListener("message", async (e) => {
          if (cancelled) return
          const ev = JSON.parse(e.data) as RealtimeEvent
          if (ev.type === "response.function_call_arguments.done" && ev.item?.type === "function_call") {
            const name = ev.item.name ?? ""
            const args = ev.item.arguments ?? "{}"
            const output = await handleFunctionCall(name, args)
            dc.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: ev.item.id,
                  output,
                },
              })
            )
          }
        })
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const res = await fetch("/api/realtime/call", { method: "POST", body: offer.sdp ?? "" })
        if (!res.ok) throw new Error(await res.text())
        const answerSdp = await res.text()
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp })
        if (!cancelled) setConnected(true)
      } catch (err) {
        if (!cancelled) {
          setStatus("error")
          setError(String(err))
        }
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [active, handleFunctionCall, setStatus, setError])

  return null
}
