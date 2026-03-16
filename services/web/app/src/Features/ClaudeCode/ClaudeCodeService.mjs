import pty from 'node-pty'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import fs from 'node:fs/promises'
import path from 'node:path'

class ClaudeCodeService {
  constructor() {
    this.sessions = new Map()
    this.sessionTimeouts = new Map()
    this.maxBufferedOutputBytes = 64 * 1024
  }

  async createSession(projectId, userId) {
    if (this.sessions.has(projectId)) {
      logger.info({ projectId }, 'Claude Code session already exists')
      return this.sessions.get(projectId)
    }

    try {
      const workDir = path.join(Settings.claudeCode.workspaceBasePath, `workspace-${projectId}`)
      await fs.mkdir(workDir, { recursive: true })

      const terminalPath =
        Settings.claudeCode.cliPath || process.env.SHELL || '/bin/bash'
      const terminalArgs = terminalPath.endsWith('bash') ||
        terminalPath.endsWith('zsh') ||
        terminalPath.endsWith('sh')
        ? ['-i']
        : []

      const ptyProcess = pty.spawn(terminalPath, terminalArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        cwd: workDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          CLAUDE_CODE_PROJECT_ID: projectId,
          OVERLEAF_PROJECT_ID: projectId,
          OVERLEAF_WORKDIR: workDir,
        },
      })

      const session = {
        pty: ptyProcess,
        userId,
        projectId,
        workDir,
        createdAt: Date.now(),
        connections: new Map(),
        outputBuffer: '',
      }

      this.sessions.set(projectId, session)

      ptyProcess.onData(data => {
        session.outputBuffer = `${session.outputBuffer}${data}`.slice(
          -this.maxBufferedOutputBytes
        )

        for (const sendOutput of session.connections.values()) {
          sendOutput(data)
        }
      })

      ptyProcess.onExit(({ exitCode, signal }) => {
        logger.info({ projectId, exitCode, signal }, 'Claude Code PTY exited')
        this.destroySession(projectId).catch(error => {
          logger.error({ projectId, error }, 'Error destroying terminal session after PTY exit')
        })
      })

      logger.info(
        { projectId, userId, workDir, terminalPath, terminalArgs },
        'Terminal session created'
      )
      return session
    } catch (error) {
      logger.error({ projectId, error }, 'Failed to create Claude Code session')
      throw error
    }
  }

  async destroySession(projectId) {
    const session = this.sessions.get(projectId)
    if (!session) {
      return
    }

    try {
      if (this.sessionTimeouts.has(projectId)) {
        clearTimeout(this.sessionTimeouts.get(projectId))
        this.sessionTimeouts.delete(projectId)
      }

      if (session.pty) {
        session.pty.kill()
      }

      if (session.workDir) {
        await fs.rm(session.workDir, { recursive: true, force: true }).catch(() => {})
      }

      this.sessions.delete(projectId)
      logger.info({ projectId }, 'Claude Code session destroyed')
    } catch (error) {
      logger.error({ projectId, error }, 'Error destroying Claude Code session')
    }
  }

  getSession(projectId) {
    return this.sessions.get(projectId)
  }

  writeToTerminal(projectId, data) {
    const session = this.sessions.get(projectId)
    if (!session) {
      throw new Error('Session not found')
    }
    session.pty.write(data)
  }

  resizeTerminal(projectId, cols, rows) {
    const session = this.sessions.get(projectId)
    if (!session) {
      throw new Error('Session not found')
    }
    session.pty.resize(cols, rows)
  }

  addConnection(projectId, socketId, sendOutput) {
    const session = this.sessions.get(projectId)
    if (session) {
      session.connections.set(socketId, sendOutput)
      if (this.sessionTimeouts.has(projectId)) {
        clearTimeout(this.sessionTimeouts.get(projectId))
        this.sessionTimeouts.delete(projectId)
      }

      if (session.outputBuffer.length > 0) {
        sendOutput(session.outputBuffer)
      }
    }
  }

  removeConnection(projectId, socketId) {
    const session = this.sessions.get(projectId)
    if (session) {
      session.connections.delete(socketId)

      if (session.connections.size === 0) {
        const timeout = setTimeout(() => {
          logger.info({ projectId }, 'No connections, destroying session after timeout')
          this.destroySession(projectId).catch(error => {
            logger.error({ projectId, error }, 'Error destroying terminal session after idle timeout')
          })
        }, 300000) // 5 minutes

        this.sessionTimeouts.set(projectId, timeout)
      }
    }
  }

  async cleanup() {
    logger.info('Cleaning up all Claude Code sessions')
    const projectIds = Array.from(this.sessions.keys())
    await Promise.all(projectIds.map(id => this.destroySession(id)))
  }
}

export default new ClaudeCodeService()
