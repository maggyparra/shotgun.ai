"use client"

import { useCallback, useRef, useState } from "react"
import type { CopilotAction, CopilotContext } from "@/lib/copilot-types"

type VoiceCopilotProps = {
  context: CopilotContext
  onAddStopWithQuery?: (query: string, maxMinutesAdded?: number, maxMinutesFromNow?: number) => void
  onAddStopPlace?: (name: string, address: string, lat: number, lng: number) => void
  onRequestAlternateRoute?: () => void
  onNavigateTo?: (query: string) => void
  onSearchNearby?: (query: string) => void
  onPickOption?: (index: number) => void
}

const SpeechRecognitionAPI =
  typeof window !== "undefined"
    ? (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition
    : null

export function VoiceCopilot({
  context,
  onAddStopWithQuery,
  onAddStopPlace,
  onRequestAlternateRoute,
  onNavigateTo,
  onSearchNearby,
  onPickOption,
}: VoiceCopilotProps) {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [reply, setReply] = useState("")
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<{ start(): void; stop(): void } | null>(null)
  const transcriptRef = useRef("")

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined") return
    window.speechSynthesis?.cancel()
    const fallback = () => {
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(text)
        u.rate = 0.95
        u.pitch = 1
        window.speechSynthesis.speak(u)
      }
    }
    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("TTS unavailable")
        return r.arrayBuffer()
      })
      .then((buf) => {
        const blob = new Blob([buf], { type: "audio/mpeg" })
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.onended = () => URL.revokeObjectURL(url)
        audio.onerror = fallback
        audio.play().catch(fallback)
      })
      .catch(fallback)
  }, [])

  const sendToCopilot = useCallback(
    async (userTranscript: string) => {
      if (!userTranscript.trim()) return
      setReply("")
      setError(null)
      try {
        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: userTranscript, context }),
        })
        const data = (await res.json()) as { reply?: string; action?: CopilotAction }
        const replyText = data.reply ?? "I didn’t get that."
        setReply(replyText)
        speak(replyText)

        const action = data.action
        if (action?.type === "add_stop" && action.query && onAddStopWithQuery) {
          onAddStopWithQuery(
            action.query,
            action.maxMinutesAdded,
            action.maxMinutesFromNow
          )
        } else if (
          action?.type === "add_stop_place" &&
          action.name &&
          action.lat != null &&
          action.lng != null &&
          onAddStopPlace
        ) {
          onAddStopPlace(action.name, action.address ?? action.name, action.lat, action.lng)
        } else if (action?.type === "request_alternate_route" && onRequestAlternateRoute) {
          onRequestAlternateRoute()
        } else if (action?.type === "navigate_to" && action.query && onNavigateTo) {
          onNavigateTo(action.query)
        } else if (action?.type === "search_nearby" && action.query && onSearchNearby) {
          onSearchNearby(action.query)
        } else if (action?.type === "pick_option" && action.index >= 0 && onPickOption) {
          onPickOption(action.index)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Request failed"
        setError(msg)
        setReply("")
      }
    },
    [context, speak, onAddStopWithQuery, onAddStopPlace, onRequestAlternateRoute, onNavigateTo, onSearchNearby, onPickOption]
  )

  const startListening = useCallback(() => {
    if (!SpeechRecognitionAPI) {
      setError("Speech recognition not supported in this browser. Try Chrome.")
      return
    }
    setError(null)
    setTranscript("")
    setReply("")
    const rec = new SpeechRecognitionAPI() as {
      continuous: boolean
      interimResults: boolean
      lang: string
      onresult: (e: { results: Iterable<{ isFinal: boolean; 0: { transcript: string }; length: number }> }) => void
      onend: () => void
      onerror: (e: { error: string }) => void
      start(): void
      stop(): void
    }
    rec.continuous = true
    rec.interimResults = true
    rec.lang = "en-US"
    rec.onresult = (e) => {
      const results = Array.from(e.results)
      const final = results
        .filter((r) => r.isFinal)
        .map((r) => r[0].transcript)
        .join(" ")
      const interim = results
        .filter((r) => !r.isFinal)
        .map((r) => r[0].transcript)
        .join(" ")
      const t = (final || interim || "").trim()
      transcriptRef.current = t
      setTranscript(t)
    }
    rec.onend = () => {
      setIsListening(false)
      const t = transcriptRef.current.trim()
      if (t) sendToCopilot(t)
    }
    rec.onerror = (e: { error: string }) => {
      if (e.error === "not-allowed") setError("Microphone access denied.")
      else if (e.error !== "aborted") setError("Speech recognition error.")
      setIsListening(false)
    }
    recognitionRef.current = rec
    rec.start()
    setIsListening(true)
  }, [sendToCopilot])

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setIsListening(false)
  }, [])

  const handleMicClick = useCallback(() => {
    if (isListening) stopListening()
    else startListening()
  }, [isListening, startListening, stopListening])

  return (
    <div className="absolute bottom-20 right-4 z-20 flex flex-col items-end gap-2">
      {(transcript || reply || error) && (
        <div className="max-w-xs rounded-xl border border-zinc-600 bg-zinc-900/95 px-3 py-2.5 text-sm shadow-lg backdrop-blur">
          {transcript ? (
            <p className="text-zinc-400">
              <span className="font-medium text-zinc-300">You:</span> {transcript}
            </p>
          ) : null}
          {reply ? (
            <p className="mt-1.5 text-cyan-100">
              <span className="font-medium text-cyan-300">Copilot:</span> {reply}
            </p>
          ) : null}
          {error ? (
            <p className="mt-1.5 text-red-400 text-xs">{error}</p>
          ) : null}
        </div>
      )}
      <button
        type="button"
        onClick={handleMicClick}
        aria-label={isListening ? "Stop listening" : "Talk to copilot"}
        className={`flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition ${
          isListening
            ? "bg-red-500 text-white animate-pulse"
            : "bg-cyan-600 text-white hover:bg-cyan-500"
        }`}
      >
        {isListening ? (
          <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg className="h-7 w-7" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.83V20c0 .55.45 1 1 1s1-.45 1-1v-2.18c3-.48 5.42-2.83 5.91-5.83.1-.6-.39-1.14-1-1.14z" />
          </svg>
        )}
      </button>
      <p className="text-[10px] text-zinc-500">
        {isListening ? "Listening… release to send" : "Tap to talk"}
      </p>
    </div>
  )
}
