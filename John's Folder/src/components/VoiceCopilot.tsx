"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { CopilotAction, CopilotContext } from "@/lib/copilot-types"

type VoiceCopilotProps = {
  context: CopilotContext
  /** One-time spoken line when within ~1.5 mi of next turn (e.g. "Get in the right lane..."). */
  proactiveChimeText?: string | null
  /** Path index of the step we're chiming for; speak only once per index. */
  proactiveChimePathIndex?: number | null
  /** "Turn left here" / "Take the exit now" when within 150m of the turn; speak once per step. */
  proactiveChimeAtTurnText?: string | null
  proactiveChimeAtTurnPathIndex?: number | null
  onAddStopWithQuery?: (query: string, maxMinutesAdded?: number, maxMinutesFromNow?: number) => void
  onAddStopPlace?: (name: string, address: string, lat: number, lng: number) => void
  onRequestAlternateRoute?: () => void
  onNavigateTo?: (query: string) => void
  onSearchNearby?: (query: string) => void
  onPickOption?: (index: number) => void
  /** Show the add-stop list with a fixed set of places (e.g. Royal Gas, Shell, ARCO near Palega). */
  onShowAddStopOptions?: (places: { name: string; address?: string; lat: number; lng: number }[]) => void
}

const SpeechRecognitionAPI =
  typeof window !== "undefined"
    ? (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition
    : null

const WAKE_PHRASE = /^\s*(?:hey\s+)?shot\s*gun\s*,?\s*/i

/** Play a short chime so user knows Shotgun is ready to listen. */
function playChime() {
  if (typeof window === "undefined") return
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 520
    osc.type = "sine"
    gain.gain.setValueAtTime(0.15, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.12)
  } catch {
    // ignore
  }
}

const SILENCE_DURATION_MS = 1500
const SILENCE_RMS_THRESHOLD = 0.015

/** Start silence detection on stream; call onSilent after continuous silence. Returns cleanup. */
function startSilenceDetector(stream: MediaStream, onSilent: () => void): () => void {
  let rafId = 0
  let closed = false
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return () => {}
    const ctx = new Ctx()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)
    const dataArray = new Uint8Array(analyser.fftSize)
    let lastLoudTime = Date.now()
    const check = () => {
      if (closed) return
      rafId = requestAnimationFrame(check)
      analyser.getByteTimeDomainData(dataArray)
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        const n = (dataArray[i] - 128) / 128
        sum += n * n
      }
      const rms = Math.sqrt(sum / dataArray.length)
      if (rms > SILENCE_RMS_THRESHOLD) lastLoudTime = Date.now()
      else if (Date.now() - lastLoudTime >= SILENCE_DURATION_MS) {
        cancelAnimationFrame(rafId)
        rafId = 0
        source.disconnect()
        ctx.close()
        closed = true
        onSilent()
      }
    }
    rafId = requestAnimationFrame(check)
    return () => {
      if (closed) return
      closed = true
      cancelAnimationFrame(rafId)
      source.disconnect()
      ctx.close()
    }
  } catch {
    return () => {}
  }
}

/** Strip wake phrase from start of transcript; return remainder or null if no wake phrase. Empty string = wake only (next utterance is command). */
function stripWakePhrase(transcript: string): string | null {
  const t = transcript.trim()
  const match = t.match(WAKE_PHRASE)
  if (!match) {
    if (/\bshot\s*gun\b/i.test(t)) return "" // "shotgun" alone → next utterance is the command
    return null
  }
  const after = t.slice(match[0].length).trim()
  return after
}

/** Normalize for dedupe: lowercase, collapse spaces, remove punctuation. */
function normalizeForDedupe(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.,;:'"]/g, "")
    .trim()
}

export function VoiceCopilot({
  context,
  proactiveChimeText,
  proactiveChimePathIndex,
  proactiveChimeAtTurnText,
  proactiveChimeAtTurnPathIndex,
  onAddStopWithQuery,
  onAddStopPlace,
  onRequestAlternateRoute,
  onNavigateTo,
  onSearchNearby,
  onPickOption,
  onShowAddStopOptions,
}: VoiceCopilotProps) {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [reply, setReply] = useState("")
  const [error, setError] = useState<string | null>(null)
  /** When true, continuously listen for "Hey Shotgun" and send the rest to copilot. */
  const [listenForWakeWord, setListenForWakeWord] = useState(true)
  const recognitionRef = useRef<{ start(): void; stop(): void } | null>(null)
  const transcriptRef = useRef("")
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const useWhisperRef = useRef(false)
  const recordingMimeRef = useRef("audio/webm")
  /** When true, only use server STT (MediaRecorder → /api/transcribe); never use browser SpeechRecognition. */
  const serverSttOnlyRef = useRef(false)
  /** One-time unlock so Chrome allows TTS playback after async fetch (user gesture is preserved). */
  const audioUnlockedRef = useRef(false)
  /** Last path index we spoke proactive chime for; speak only once per step. */
  const lastSpokenChimePathIndexRef = useRef<number | null>(null)
  /** Last path index we spoke "at turn" chime for (e.g. "Turn left here" when within 150m). */
  const lastSpokenChimeAtTurnPathIndexRef = useRef<number | null>(null)
  /** Wake-word: separate recognition instance for always-on "Hey Shotgun". */
  const wakeRecognitionRef = useRef<{ start(): void; stop(): void } | null>(null)
  const listenForWakeWordRef = useRef(listenForWakeWord)
  listenForWakeWordRef.current = listenForWakeWord
  /** When true, we're in a listening session started by "Hey Shotgun"; restart wake rec when done. */
  const wakeWordSessionRef = useRef(false)
  /** Ref so wake-word callback can see current listening state. */
  const isListeningRef = useRef(false)
  isListeningRef.current = isListening
  /** Short cooldown after wake trigger so we don't start two sessions from duplicate results. */
  const lastWakeTriggerTimeRef = useRef(0)
  const WAKE_TRIGGER_COOLDOWN_MS = 2000
  /** Set by wake-word effect so we can restart recognition after the voice session ends. */
  const restartWakeRecognitionRef = useRef<(() => void) | null>(null)
  /** When listening was started by "Hey Shotgun": silence detector cleanup (stop listening when user goes silent). */
  const silenceDetectorCleanupRef = useRef<(() => void) | null>(null)
  /** Last time we sent to copilot (used by speak onDone); kept so existing callback does not throw. */
  const wakeLastSendTimeRef = useRef(0)
  /** True from moment we send a wake-word command until TTS finishes — ignore all recognition during this. */
  const isCopilotSpeakingRef = useRef(false)

  const unlockAudio = useCallback(() => {
    if (audioUnlockedRef.current || typeof window === "undefined") return
    audioUnlockedRef.current = true
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctx) {
        const ctx = new Ctx()
        if (ctx.resume) ctx.resume()
      }
    } catch {
      // ignore
    }
  }, [])

  /** Slightly faster than normal for driving (1.0 = normal, 1.35 = a bit quicker). */
  const TTS_SPEED = 1.35

  const speak = useCallback((text: string, onDone?: () => void) => {
    if (typeof window === "undefined") return
    window.speechSynthesis?.cancel()
    const fallback = () => {
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(text)
        u.rate = TTS_SPEED
        u.pitch = 1
        u.onend = () => onDone?.()
        window.speechSynthesis.speak(u)
      } else {
        onDone?.()
      }
    }
    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, speed: TTS_SPEED }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("TTS unavailable")
        return r.arrayBuffer()
      })
      .then((buf) => {
        const blob = new Blob([buf], { type: "audio/mpeg" })
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.onended = () => {
          URL.revokeObjectURL(url)
          onDone?.()
        }
        audio.onerror = () => {
          fallback()
        }
        const p = audio.play()
        if (p && typeof p.then === "function") {
          p.catch(() => fallback())
        } else {
          fallback()
        }
      })
      .catch(() => {
        fallback()
      })
  }, [])

  useEffect(() => {
    fetch("/api/transcribe/status")
      .then((r) => (r.ok ? r.json() : { stt: null }))
      .then((data: { stt?: string }) => {
        serverSttOnlyRef.current = data.stt === "openai"
      })
      .catch(() => {})
  }, [])

  /** Proactive chime: speak once per step when within ~1.5 mi of next turn. */
  useEffect(() => {
    if (proactiveChimePathIndex == null) {
      lastSpokenChimePathIndexRef.current = null
      return
    }
    if (
      proactiveChimeText &&
      proactiveChimePathIndex !== lastSpokenChimePathIndexRef.current
    ) {
      lastSpokenChimePathIndexRef.current = proactiveChimePathIndex
      speak(proactiveChimeText)
    }
  }, [proactiveChimeText, proactiveChimePathIndex, speak])

  /** At-turn chime: "Turn left here" / "Take the exit now" when within 150m; speak once per maneuver. */
  useEffect(() => {
    if (proactiveChimeAtTurnPathIndex == null) {
      lastSpokenChimeAtTurnPathIndexRef.current = null
      return
    }
    if (
      proactiveChimeAtTurnText &&
      proactiveChimeAtTurnPathIndex !== lastSpokenChimeAtTurnPathIndexRef.current
    ) {
      lastSpokenChimeAtTurnPathIndexRef.current = proactiveChimeAtTurnPathIndex
      speak(proactiveChimeAtTurnText)
    }
  }, [proactiveChimeAtTurnText, proactiveChimeAtTurnPathIndex, speak])

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
        const replyText = data.reply ?? "I didn't get that."
        setReply(replyText)
        speak(replyText, () => {
          wakeLastSendTimeRef.current = Date.now()
          isCopilotSpeakingRef.current = false
        })

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
        } else if (action?.type === "add_stop_options" && action.places?.length && onShowAddStopOptions) {
          onShowAddStopOptions(action.places)
        } else if (action?.type === "pick_option" && action.index >= 0 && onPickOption) {
          onPickOption(action.index)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Request failed"
        setError(msg)
        setReply("")
        isCopilotSpeakingRef.current = false
      }
    },
    [context, speak, onAddStopWithQuery, onAddStopPlace, onRequestAlternateRoute, onNavigateTo, onSearchNearby, onShowAddStopOptions, onPickOption]
  )

  const sendToCopilotRef = useRef(sendToCopilot)
  sendToCopilotRef.current = sendToCopilot
  const startListeningRef = useRef<(opts?: { fromWakeWord?: boolean }) => void>(() => {})

  /** Always-on "Hey Shotgun": when heard, chime then start the same flow as the voice button (same UI + STT); 10s auto-send. */
  useEffect(() => {
    if (!listenForWakeWord || !SpeechRecognitionAPI) return
    unlockAudio()
    let streamForMic: MediaStream | null = null
    const startWakeRecognition = () => {
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
      rec.onresult = (e: { results: Iterable<{ isFinal: boolean; 0: { transcript: string }; length: number }> }) => {
        if (isListeningRef.current) return
        if (Date.now() - lastWakeTriggerTimeRef.current < WAKE_TRIGGER_COOLDOWN_MS) return
        const results = Array.from(e.results)
        const fullTranscript = results
          .filter((r) => r.isFinal)
          .map((r) => r[0]?.transcript ?? "")
          .join(" ")
          .trim()
        if (!fullTranscript) return
        const hasWake = stripWakePhrase(fullTranscript) !== null
        if (!hasWake) return
        lastWakeTriggerTimeRef.current = Date.now()
        playChime()
        try {
          rec.stop()
        } catch {
          // ignore
        }
        wakeRecognitionRef.current = null
        setTimeout(() => {
          if (!listenForWakeWordRef.current || isListeningRef.current) return
          startListeningRef.current({ fromWakeWord: true })
        }, 300)
      }
      rec.onend = () => {
        if (wakeRecognitionRef.current === rec && listenForWakeWordRef.current) {
          try {
            rec.start()
          } catch {
            wakeRecognitionRef.current = null
          }
        }
      }
      rec.onerror = (e: { error: string }) => {
        if (e.error === "not-allowed") {
          setError("Microphone access denied for wake word.")
        } else if (e.error !== "aborted" && e.error !== "no-speech") {
          setError("Wake word listening error.")
        }
        if (e.error === "not-allowed") wakeRecognitionRef.current = null
      }
      wakeRecognitionRef.current = rec
      rec.start()
    }
    restartWakeRecognitionRef.current = startWakeRecognition
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
          streamForMic = stream
          startWakeRecognition()
        })
        .catch(() => {
          setError("Allow microphone access for Hey Shotgun, then try again.")
        })
    } else {
      startWakeRecognition()
    }
    return () => {
      streamForMic?.getTracks().forEach((t) => t.stop())
      restartWakeRecognitionRef.current = null
      if (wakeRecognitionRef.current) {
        try {
          (wakeRecognitionRef.current as { stop(): void }).stop()
        } catch {
          // ignore
        }
        wakeRecognitionRef.current = null
      }
    }
  }, [listenForWakeWord, unlockAudio])

  const startListening = useCallback((opts?: { fromWakeWord?: boolean }) => {
    silenceDetectorCleanupRef.current?.()
    silenceDetectorCleanupRef.current = null
    if (opts?.fromWakeWord) wakeWordSessionRef.current = true
    unlockAudio()
    setError(null)
    setTranscript("")
    setReply("")
    chunksRef.current = []
    useWhisperRef.current = false

    const useMediaRecorder =
      typeof navigator !== "undefined" &&
      navigator.mediaDevices?.getUserMedia &&
      typeof window !== "undefined" &&
      window.MediaRecorder

    if (useMediaRecorder) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          streamRef.current = stream
          const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm"
          recordingMimeRef.current = mime
          const rec = new MediaRecorder(stream, { mimeType: mime })
          rec.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data)
          }
          rec.start()
          mediaRecorderRef.current = rec
          useWhisperRef.current = true
          setIsListening(true)
          if (opts?.fromWakeWord && streamRef.current) {
            silenceDetectorCleanupRef.current = startSilenceDetector(streamRef.current, () => {
              silenceDetectorCleanupRef.current = null
              stopListeningRef.current()
            })
          }
        })
        .catch(() => {
          useWhisperRef.current = false
          if (opts?.fromWakeWord) wakeWordSessionRef.current = false
          if (serverSttOnlyRef.current) {
            setError("Microphone access is needed for voice. Allow the mic and try again.")
            return
          }
          startWithBrowserRecognition()
        })
      return
    }
    if (serverSttOnlyRef.current) {
      setError("Voice needs a browser that supports recording (e.g. Chrome).")
      return
    }
    startWithBrowserRecognition()
  }, [sendToCopilot, unlockAudio])
  startListeningRef.current = startListening

  function startWithBrowserRecognition() {
    if (!SpeechRecognitionAPI) {
      setError("Speech recognition not supported. Try Chrome or add OPENAI_API_KEY for Whisper.")
      return
    }
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
      if (wakeWordSessionRef.current) {
        wakeWordSessionRef.current = false
        restartWakeRecognitionRef.current?.()
      }
      const t = transcriptRef.current.trim()
      if (t) sendToCopilot(t)
    }
    rec.onerror = (e: { error: string }) => {
      if (e.error === "not-allowed") setError("Microphone access denied.")
      else if (e.error !== "aborted") setError("Speech recognition error.")
      setIsListening(false)
      if (wakeWordSessionRef.current) {
        wakeWordSessionRef.current = false
        restartWakeRecognitionRef.current?.()
      }
    }
    recognitionRef.current = rec
    rec.start()
    setIsListening(true)
  }

  const stopListening = useCallback(() => {
    silenceDetectorCleanupRef.current?.()
    silenceDetectorCleanupRef.current = null
    if (useWhisperRef.current && mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.onstop = () => {
        const mime = recordingMimeRef.current
        const blob = new Blob(chunksRef.current, { type: mime })
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        mediaRecorderRef.current = null
        setIsListening(false)
        if (wakeWordSessionRef.current) {
          wakeWordSessionRef.current = false
          restartWakeRecognitionRef.current?.()
        }
        if (blob.size < 500) {
          setError("Recording too short. Try again.")
          return
        }
        const form = new FormData()
        form.append("file", blob, "audio.webm")
        setTranscript("…")
        fetch("/api/transcribe", { method: "POST", body: form })
          .then((res) => res.json().then((data: { text?: string; error?: string }) => ({ res, data })))
          .then(({ res, data }) => {
            const text = (data.text ?? "").trim()
            if (text) {
              setTranscript(text)
              sendToCopilot(text)
            } else if (res.status === 503 || data.error) {
              setError(data.error ?? "Add OPENAI_API_KEY for better voice recognition.")
            } else {
              setError("Couldn't make out what you said. Try again.")
            }
          })
          .catch(() => setError("Transcription failed. Try again."))
      }
      mediaRecorderRef.current.stop()
      return
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setIsListening(false)
    if (wakeWordSessionRef.current) {
      wakeWordSessionRef.current = false
      restartWakeRecognitionRef.current?.()
    }
  }, [sendToCopilot])
  const stopListeningRef = useRef(stopListening)
  stopListeningRef.current = stopListening

  const handleMicClick = useCallback(() => {
    if (isListening) stopListening()
    else startListening()
  }, [isListening, startListening, stopListening])

  return (
    <div className="absolute bottom-20 right-4 z-[100] flex flex-col items-end gap-2">
      {listenForWakeWord && (
        <div className="rounded-lg border border-cyan-600/50 bg-cyan-950/80 px-2.5 py-1.5 text-xs text-cyan-200">
          Listening for &quot;Hey Shotgun&quot;…
        </div>
      )}
      {(transcript || reply || error) && (
        <div className="max-w-xs rounded-xl border border-zinc-600 bg-zinc-900/95 px-3 py-2.5 text-sm shadow-lg backdrop-blur">
          {transcript ? (
            <p className="text-zinc-400">
              <span className="font-medium text-zinc-300">You:</span> {transcript}
            </p>
          ) : null}
          {reply ? (
            <p className="mt-1.5 text-cyan-100">
              <span className="font-medium text-cyan-300">Shotgun:</span> {reply}
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
        aria-label={isListening ? "Stop listening" : "Talk to Shotgun"}
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
      <button
        type="button"
        onClick={() => setListenForWakeWord((w) => !w)}
        aria-label={listenForWakeWord ? "Stop listening for Hey Shotgun" : "Listen for Hey Shotgun"}
        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
          listenForWakeWord
            ? "bg-cyan-600 text-white"
            : "bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200"
        }`}
      >
        {listenForWakeWord ? "On: Hey Shotgun" : "Hey Shotgun"}
      </button>
    </div>
  )
}
