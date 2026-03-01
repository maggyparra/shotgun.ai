"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Live HUD transcription overlay — glassmorphism box with real-time speech-to-text.
 * Requests mic permission on mount. Shows listening pulse when capturing.
 */
export function LiveTranscriptionHUD({
  active,
  agentStatus,
  agentResponse,
  useRealtimeVoice,
  onTranscriptUpdate,
  onConfirmStop,
  onCancelStop,
}: {
  /** When true, HUD is visible and capturing (e.g. during turn-by-turn) */
  active: boolean
  /** When "searching", show AGENT SEARCHING in glass box */
  agentStatus?: "idle" | "searching" | "confirming" | "error"
  /** Verbal agent reply, e.g. "WE found X. It adds Y minutes. Should WE add it?" */
  agentResponse?: string | null
  /** When true, mic is used by Realtime—skip Web Speech to avoid conflict */
  useRealtimeVoice?: boolean
  /** Called when transcript gets new final text (full transcript, new chunk) */
  onTranscriptUpdate?: (fullTranscript: string, newChunk: string) => void
  /** Called when user confirms adding the stop (tap Yes) */
  onConfirmStop?: () => void
  /** Called when user cancels (tap No) */
  onCancelStop?: () => void
}) {
  const [transcript, setTranscript] = useState("")
  const [interim, setInterim] = useState("")
  const [isListening, setIsListening] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const onTranscriptUpdateRef = useRef(onTranscriptUpdate)
  onTranscriptUpdateRef.current = onTranscriptUpdate

  useEffect(() => {
    if (!active || useRealtimeVoice) {
      recognitionRef.current?.stop()
      recognitionRef.current = null
      setIsListening(false)
      return
    }

    if (typeof window === "undefined" || (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window))) {
      setMicError("Speech recognition not supported.")
      return
    }
    const SpeechRecognitionAPI =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition
    if (!SpeechRecognitionAPI) return

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(() => {
        setMicError(null)
        const recognition = new SpeechRecognitionAPI()
        recognition.continuous = true
        recognition.interimResults = true
        recognition.lang = "en-US"

        recognition.onresult = (event: SpeechRecognitionEvent) => {
          let finalChunk = ""
          let latestInterim = ""
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i]
            const text = (result[0]?.transcript ?? "").trim()
            if (!text) continue
            if (result.isFinal) {
              finalChunk += (finalChunk ? " " : "") + text
            } else {
              latestInterim = text
            }
          }
          if (finalChunk) {
            const add = finalChunk.trim()
            setTranscript((prev) => {
              if (!add) return prev
              const next = !prev ? add : (prev.endsWith(add) ? prev : add.startsWith(prev) ? add : `${prev} ${add}`)
              if (next !== prev) setTimeout(() => onTranscriptUpdateRef.current?.(next, add), 0)
              return next
            })
          }
          setInterim(latestInterim)
        }

        recognition.onstart = () => setIsListening(true)
        recognition.onend = () => setIsListening(false)
        recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
          if (e.error === "not-allowed") setMicError("Microphone access denied.")
          else if (e.error !== "aborted") setMicError(e.error)
        }

        recognitionRef.current = recognition
        recognition.start()
      })
      .catch((err) => {
        setMicError(err.message || "Could not access microphone.")
      })

    return () => {
      recognitionRef.current?.stop()
      recognitionRef.current = null
    }
  }, [active, useRealtimeVoice])

  // Clear transcript and interim when going inactive
  useEffect(() => {
    if (!active) {
      setTranscript("")
      setInterim("")
    }
  }, [active])

  if (!active) return null

  return (
    <div
      className={`absolute bottom-24 left-1/2 z-20 w-[min(90vw,520px)] -translate-x-1/2 rounded-2xl border-2 px-5 py-4 shadow-2xl backdrop-blur-2xl backdrop-saturate-150 transition-all duration-300 ${
        isListening
          ? "border-sky-400/70 bg-white/40 shadow-sky-400/20"
          : "border-white/20 bg-white/30"
      } ${isListening ? "animate-pulse-subtle" : ""}`}
      style={
        isListening
          ? {
              boxShadow: "0 0 0 2px rgba(56, 189, 248, 0.3), 0 25px 50px -12px rgba(0,0,0,0.15)",
              animation: "pulse-subtle 1.5s ease-in-out infinite",
            }
          : undefined
      }
    >
      <style>{`
        @keyframes pulse-subtle {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.3); }
          50% { opacity: 0.95; box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.5); }
        }
      `}</style>
      {micError ? (
        <p className="text-lg font-medium text-red-600">{micError}</p>
      ) : (
        <>
          <p className="min-h-[2.5rem] text-xl font-medium leading-relaxed text-zinc-800">
            {agentStatus === "searching"
              ? "AGENT SEARCHING…"
              : (agentResponse ?? [transcript, interim].filter(Boolean).join(" ")) || (isListening || useRealtimeVoice ? "Listening…" : "Speak to see transcription")}
          </p>
          {agentStatus === "confirming" && (onConfirmStop ?? onCancelStop) && (
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={onConfirmStop}
                className="rounded-xl bg-emerald-600 px-6 py-2.5 text-lg font-semibold text-white shadow-lg transition hover:bg-emerald-500 active:scale-95"
              >
                Yes, add it
              </button>
              <button
                type="button"
                onClick={onCancelStop}
                className="rounded-xl border-2 border-zinc-400 px-6 py-2.5 text-lg font-semibold text-zinc-700 transition hover:bg-zinc-100 active:scale-95"
              >
                No, stay on route
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
