import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import { useTranslation } from 'react-i18next'
import { useClaudeCodeContext } from '../context/claude-code-context'
import { postJSON } from '@/infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'
import { useProjectContext } from '@/shared/context/project-context'
import OLButton from '@/shared/components/ol/ol-button'
import { useModalsContext } from '@/features/ide-react/context/modals-context'
import 'xterm/css/xterm.css'

const TERMINAL_TITLE = 'Terminal'

export default function ClaudeCodePane() {
  const { t } = useTranslation()
  const { projectId } = useProjectContext()
  const { socket, status, error, connect } = useClaudeCodeContext()
  const {
    genericModalVisible,
    genericMessageModalKind,
    hideGenericMessageModal,
  } = useModalsContext()
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const terminalMountRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [sessionCreated, setSessionCreated] = useState(false)
  const [isCreatingSession, setIsCreatingSession] = useState(false)

  const isExternalUpdateModalVisible =
    genericModalVisible &&
    genericMessageModalKind === 'document-updated-externally'

  const createSession = useCallback(async () => {
    if (!projectId || isCreatingSession || sessionCreated) {
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

  const syncTerminalSize = useCallback(() => {
    const terminal = xtermRef.current
    const fitAddon = fitAddonRef.current

    if (!terminal || !fitAddon) {
      return
    }

    fitAddon.fit()

    if (socket?.connected) {
      socket.emit('terminal-resize', {
        cols: terminal.cols,
        rows: terminal.rows,
      })
    }
  }, [socket])

  useEffect(() => {
    if (!terminalContainerRef.current || !terminalMountRef.current) {
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
    terminal.open(terminalMountRef.current)

    xtermRef.current = terminal
    fitAddonRef.current = fitAddon

    requestAnimationFrame(() => {
      syncTerminalSize()
    })

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        syncTerminalSize()
      })
    })

    resizeObserver.observe(terminalContainerRef.current)

    return () => {
      resizeObserver.disconnect()
      terminal.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [syncTerminalSize])

  useEffect(() => {
    if (!socket || !xtermRef.current) {
      return
    }

    const terminal = xtermRef.current

    const handleTerminalOutput = (data: string) => {
      terminal.write(data)
    }

    const handleSessionStarted = () => {
      syncTerminalSize()
    }

    const handleSessionError = ({ error: errorMsg }: { error: string }) => {
      terminal.writeln(`\r\n\x1b[31mError: ${errorMsg}\x1b[0m\r\n`)
    }

    socket.on('terminal-output', handleTerminalOutput)
    socket.on('session-started', handleSessionStarted)
    socket.on('session-error', handleSessionError)

    const startSession = () => {
      syncTerminalSize()
      socket.emit('start-session')
    }

    socket.on('connect', startSession)

    const disposable = terminal.onData(data => {
      socket.emit('terminal-input', data)
    })

    if (socket.connected) {
      startSession()
    }

    return () => {
      socket.off('connect', startSession)
      socket.off('terminal-output', handleTerminalOutput)
      socket.off('session-started', handleSessionStarted)
      socket.off('session-error', handleSessionError)
      disposable.dispose()
    }
  }, [socket, syncTerminalSize])

  useEffect(() => {
    createSession()
  }, [createSession])

  return (
    <div className="ide-react-editor-sidebar claude-code-pane">
      <div className="claude-code-header">
        <h3>{TERMINAL_TITLE}</h3>
        <div className="claude-code-header-actions">
          <div className="claude-code-status">
            {status === 'connecting' && <span>Connecting...</span>}
            {status === 'connected' && <span className="status-connected">Connected</span>}
            {status === 'disconnected' && <span>Disconnected</span>}
            {status === 'error' && <span className="status-error">Error: {error}</span>}
          </div>
          {isExternalUpdateModalVisible && (
            <OLButton
              variant="secondary"
              size="sm"
              onClick={hideGenericMessageModal}
              className="claude-code-dismiss-modal-button claude-code-dismiss-modal-button-floating"
            >
              {t('close_dialog')}
            </OLButton>
          )}
        </div>
      </div>
      <div className="claude-code-terminal-shell" ref={terminalContainerRef}>
        <div className="claude-code-terminal" ref={terminalMountRef} />
      </div>
    </div>
  )
}
