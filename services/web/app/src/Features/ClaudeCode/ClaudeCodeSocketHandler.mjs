import ClaudeCodeService from './ClaudeCodeService.mjs'
import logger from '@overleaf/logger'

export function setupClaudeCodeSocket(io, sessionStore) {
  const claudeCodeNamespace = io.of('/claude-code')

  claudeCodeNamespace.on('connection', socket => {
    const { projectId } = socket.handshake.query

    if (!projectId) {
      logger.error('No projectId in socket handshake')
      socket.disconnect()
      return
    }

    logger.info({ projectId, socketId: socket.id }, 'Claude Code socket connected')

    socket.on('start-session', async () => {
      try {
        const session = ClaudeCodeService.getSession(projectId)

        if (!session) {
          socket.emit('session-error', { error: 'Session not found. Please create a session first.' })
          return
        }

        ClaudeCodeService.addConnection(projectId, socket.id, data => {
          socket.emit('terminal-output', data)
        })

        socket.emit('session-started', {
          workDir: session.workDir,
        })

        logger.info({ projectId, socketId: socket.id }, 'Claude Code session started')
      } catch (error) {
        logger.error({ projectId, error }, 'Error starting Claude Code session')
        socket.emit('session-error', { error: error.message })
      }
    })

    socket.on('terminal-input', data => {
      try {
        ClaudeCodeService.writeToTerminal(projectId, data)
      } catch (error) {
        logger.error({ projectId, error }, 'Error writing to terminal')
        socket.emit('session-error', { error: error.message })
      }
    })

    socket.on('terminal-resize', ({ cols, rows }) => {
      try {
        ClaudeCodeService.resizeTerminal(projectId, cols, rows)
      } catch (error) {
        logger.error({ projectId, error }, 'Error resizing terminal')
      }
    })

    socket.on('disconnect', () => {
      logger.info({ projectId, socketId: socket.id }, 'Claude Code socket disconnected')
      ClaudeCodeService.removeConnection(projectId, socket.id)
    })
  })

  return claudeCodeNamespace
}
