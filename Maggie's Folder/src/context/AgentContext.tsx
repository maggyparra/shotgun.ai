"use client"

/**
 * Agent context — pending stop proposal, status, and confirmation flow.
 * Bridges verbal intent (propose_stop) with map action (add stop).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

export type PendingProposal = {
  name: string
  lat: number
  lng: number
  time_added: number
}

export type AgentStatus = "idle" | "searching" | "confirming" | "error"

type AgentState = {
  status: AgentStatus
  pendingProposal: PendingProposal | null
  error: string | null
  /** Verbal response to show in HUD, e.g. "WE found X. It adds Y minutes. Should WE add it?" */
  agentResponse: string | null
}

type AgentActions = {
  setStatus: (s: AgentStatus) => void
  setPendingProposal: (p: PendingProposal | null) => void
  setError: (e: string | null) => void
  setAgentResponse: (r: string | null) => void
  clearProposal: () => void
  getPendingProposalRef: () => React.MutableRefObject<PendingProposal | null>
}

const AgentContext = createContext<(AgentState & AgentActions) | null>(null)
const pendingRef = { current: null as PendingProposal | null }

export function AgentProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AgentStatus>("idle")
  const [pendingProposal, setPendingProposal] = useState<PendingProposal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agentResponse, setAgentResponse] = useState<string | null>(null)
  useEffect(() => {
    pendingRef.current = pendingProposal
  }, [pendingProposal])
  const getPendingProposalRef = useCallback(() => pendingRef as React.MutableRefObject<PendingProposal | null>, [])
  const clearProposal = useCallback(() => {
    setPendingProposal(null)
    pendingRef.current = null
    setStatus("idle")
    setError(null)
    setAgentResponse(null)
  }, [])
  const value = useMemo(
    () => ({
      status,
      pendingProposal,
      error,
      agentResponse,
      setStatus,
      setPendingProposal,
      setError,
      setAgentResponse,
      clearProposal,
      getPendingProposalRef,
    }),
    [status, pendingProposal, error, agentResponse, clearProposal, getPendingProposalRef]
  )
  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  )
}

export function useAgent() {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error("useAgent must be used within AgentProvider")
  return ctx
}
