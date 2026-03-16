import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import { useClaudeCodeContext } from '../context/claude-code-context'
import { postJSON } from '@/infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'
import { useProjectContext } from '@/shared/context/project-context'
import 'xterm/css/xterm.css'

const TERMINAL_TITLE = 'Terminal'

export default function ClaudeCodePane() {
  const { projectId } = useProjectContext()
  const { socket, status, error, connect } = useClaudeCodeContext()
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [sessionCreated, setSessionCreated] = useState(false)
  const [isCreatingSession, setIsCreatingSession] = useState(false)

  const createSession = useCallback(async () => {
    if (isCreatingSession || sessionCreated) {
      return
    }

    setIsCreatingSession(true)
    try {
      const response = await postJSON(`/project/${projectId}/claude-code/session`)
      if (response.success) {
        setSessionCreated(true)
        connect()
      }
    } catch (err) {
      debugConsole.error('Failed to create terminal session:', err)
    } finally {
      setIsCreatingSession(false)
    }
  }, [projectId, isCreatingSession, sessionCreated, connect])

  useEffect(() => {
    if (!terminalRef.current) {
      return
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
      },
      scrollback: 10000,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(terminalRef.current)

    fitAddon.fit()

    xtermRef.current = terminal
    fitAddonRef.current = fitAddon

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit()
        if (socket?.connected) {
          socket.emit('terminal-resize', {
            cols: terminal.cols,
            rows: terminal.rows,
          })
        }
      }
    })

    resizeObserver.observe(terminalRef.current)

    return () => {
      resizeObserver.disconnect()
      terminal.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [socket])

  useEffect(() => {
    if (!socket || !xtermRef.current) {
      return
    }

    const terminal = xtermRef.current

    const handleTerminalOutput = (data: string) => {
      terminal.write(data)
    }

    const handleSessionStarted = () => {
      terminal.writeln('\r\n\x1b[32mTerminal session started\x1b[0m\r\n')
    }

    const handleSessionError = ({ error: errorMsg }: { error: string }) => {
      terminal.writeln(`\r\n\x1b[31mError: ${errorMsg}\x1b[0m\r\n`)
    }

    socket.on('terminal-output', handleTerminalOutput)
    socket.on('session-started', handleSessionStarted)
    socket.on('session-error', handleSessionError)

    const disposable = terminal.onData(data => {
      socket.emit('terminal-input', data)
    })

    if (socket.connected) {
      socket.emit('start-session')
    }

    return () => {
      socket.off('terminal-output', handleTerminalOutput)
      socket.off('session-started', handleSessionStarted)
      socket.off('session-error', handleSessionError)
      disposable.dispose()
    }
  }, [socket])

  useEffect(() => {
    createSession()
  }, [createSession])

  return (
    <div className="claude-code-pane">
      <div className="claude-code-header">
        <h3>{TERMINAL_TITLE}</h3>
        <div className="claude-code-status">
          {status === 'connecting' && <span>Connecting...</span>}
          {status === 'connected' && <span className="status-connected">Connected</span>}
          {status === 'disconnected' && <span>Disconnected</span>}
          {status === 'error' && <span className="status-error">Error: {error}</span>}
        </div>
      </div>
      <div className="claude-code-terminal" ref={terminalRef} />
    </div>
  )
}
