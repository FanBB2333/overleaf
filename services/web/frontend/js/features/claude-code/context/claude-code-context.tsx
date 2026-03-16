import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import { useProjectContext } from '@/shared/context/project-context'

type ClaudeCodeContextValue = {
  socket: Socket | null
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error: string | null
  connect: () => void
  disconnect: () => void
}

const ClaudeCodeContext = createContext<ClaudeCodeContextValue | undefined>(
  undefined
)

export function ClaudeCodeProvider({ children }: { children: React.ReactNode }) {
  const { projectId } = useProjectContext()
  const [socket, setSocket] = useState<Socket | null>(null)
  const [status, setStatus] = useState<ClaudeCodeContextValue['status']>('disconnected')
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(() => {
    if (!projectId || socket?.connected) {
      return
    }

    setStatus('connecting')
    setError(null)

    const newSocket = io('/claude-code', {
      path: '/terminal/socket.io',
      query: { projectId },
      transports: ['websocket', 'polling'],
    })

    newSocket.on('connect', () => {
      setStatus('connected')
      setError(null)
    })

    newSocket.on('disconnect', () => {
      setStatus('disconnected')
    })

    newSocket.on('session-error', ({ error: errorMsg }: { error: string }) => {
      setStatus('error')
      setError(errorMsg)
    })

    newSocket.on('connect_error', (err: Error) => {
      setStatus('error')
      setError(err.message)
    })

    setSocket(newSocket)
  }, [projectId, socket])

  const disconnect = useCallback(() => {
    if (socket) {
      socket.disconnect()
      setSocket(null)
      setStatus('disconnected')
    }
  }, [socket])

  useEffect(() => {
    return () => {
      if (socket) {
        socket.disconnect()
      }
    }
  }, [socket])

  return (
    <ClaudeCodeContext.Provider
      value={{ socket, status, error, connect, disconnect }}
    >
      {children}
    </ClaudeCodeContext.Provider>
  )
}

export function useClaudeCodeContext() {
  const context = useContext(ClaudeCodeContext)
  if (!context) {
    throw new Error('useClaudeCodeContext must be used within ClaudeCodeProvider')
  }
  return context
}
