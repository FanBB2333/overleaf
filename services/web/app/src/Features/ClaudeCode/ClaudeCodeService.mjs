import pty from 'node-pty'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs/promises'
import nodeFs from 'node:fs'
import path from 'node:path'
import pLimit from 'p-limit'
import AIService from '../AI/AIService.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import EditorController from '../Editor/EditorController.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'

const WORKSPACE_SYNC_CONCURRENCY = 8
const PROJECT_SYNC_POLL_INTERVAL_MS = 1000
const WORKSPACE_SYNC_DEBOUNCE_MS = 200
const WORKSPACE_EVENT_IGNORE_MS = 2000
const TERMINAL_SYNC_SOURCE = 'terminal-workspace'
const IGNORED_WORKSPACE_PATHS = new Set([
  '/.bash_history',
  '/.zsh_history',
  '/.history',
])

function normalizeContent(content) {
  return content.replace(/\r\n/g, '\n')
}

function contentToLines(content) {
  const normalizedContent = normalizeContent(content)
  if (normalizedContent === '') {
    return ['']
  }
  return normalizedContent.split('\n')
}

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
      const workspace = await this.populateWorkspace(projectId, workDir)

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
        docStates: new Map(
          workspace.docs.map(doc => [
            this.normalizeProjectPath(doc.path),
            normalizeContent(doc.content),
          ])
        ),
        binaryPaths: new Set(
          workspace.files.map(file => this.normalizeProjectPath(file.path))
        ),
        ignoredWorkspacePaths: new Map(),
        pendingProjectSyncs: new Set(),
        workspaceSyncTimer: null,
        workspaceSyncInProgress: false,
        workspaceSyncQueued: false,
        projectSyncInProgress: false,
        projectSyncInterval: null,
        workspaceWatcher: null,
      }

      this.sessions.set(projectId, session)
      try {
        this.startSynchronization(session)
      } catch (error) {
        this.sessions.delete(projectId)
        ptyProcess.kill()
        throw error
      }

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
      this.sessions.delete(projectId)

      if (this.sessionTimeouts.has(projectId)) {
        clearTimeout(this.sessionTimeouts.get(projectId))
        this.sessionTimeouts.delete(projectId)
      }

      if (session.workspaceSyncTimer) {
        clearTimeout(session.workspaceSyncTimer)
      }

      if (session.projectSyncInterval) {
        clearInterval(session.projectSyncInterval)
      }

      if (session.workspaceWatcher) {
        session.workspaceWatcher.close()
      }

      if (session.pty) {
        session.pty.kill()
      }

      if (session.workDir) {
        await fs.rm(session.workDir, { recursive: true, force: true }).catch(() => {})
      }

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

  async populateWorkspace(projectId, workDir) {
    const workspace = await AIService.getWorkspaceSnapshot(projectId)

    await Promise.all(
      workspace.docs.map(async doc => {
        const workspacePath = this.getWorkspacePath(workDir, doc.path)
        await fs.mkdir(path.dirname(workspacePath), { recursive: true })
        await fs.writeFile(workspacePath, doc.content, 'utf-8')
      })
    )

    const filesByPath = await ProjectEntityHandler.promises.getAllFiles(projectId)
    const limit = pLimit(WORKSPACE_SYNC_CONCURRENCY)

    await Promise.all(
      Object.entries(filesByPath).map(([projectPath, file]) =>
        limit(async () => {
          if (!file.hash) {
            return
          }

          const workspacePath = this.getWorkspacePath(workDir, projectPath)
          await fs.mkdir(path.dirname(workspacePath), { recursive: true })

          try {
            const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
              projectId,
              file.hash,
              'GET'
            )
            await pipeline(stream, nodeFs.createWriteStream(workspacePath))
          } catch (error) {
            logger.warn(
              { projectId, projectPath, fileId: file._id, error },
              'Failed to project binary file into terminal workspace'
            )
          }
        })
      )
    )

    logger.info(
      {
        projectId,
        workDir,
        docCount: workspace.docs.length,
        fileCount: Object.keys(filesByPath).length,
      },
      'Projected project into terminal workspace'
    )

    return workspace
  }

  getWorkspacePath(workDir, projectPath) {
    const relativePath = this.normalizeProjectPath(projectPath).replace(/^\/+/, '')
    return path.join(workDir, relativePath)
  }

  getProjectPath(workDir, workspacePath) {
    return this.normalizeProjectPath(path.relative(workDir, workspacePath))
  }

  normalizeProjectPath(projectPath) {
    const normalizedPath = projectPath.replace(/\\/g, '/').replace(/^\/+/, '')
    return normalizedPath ? `/${normalizedPath}` : '/'
  }

  startSynchronization(session) {
    session.workspaceWatcher = nodeFs.watch(
      session.workDir,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename) {
          return
        }

        const projectPath = this.normalizeProjectPath(filename.toString())
        if (
          session.binaryPaths.has(projectPath) ||
          IGNORED_WORKSPACE_PATHS.has(projectPath) ||
          this.isWorkspacePathIgnored(session, projectPath)
        ) {
          return
        }

        this.scheduleWorkspaceSync(session)
      }
    )

    session.workspaceWatcher.on('error', error => {
      logger.error(
        { projectId: session.projectId, error },
        'Workspace watcher failed for terminal session'
      )
    })

    session.projectSyncInterval = setInterval(() => {
      this.syncProjectToWorkspace(session).catch(error => {
        logger.error(
          { projectId: session.projectId, error },
          'Failed to sync project changes into terminal workspace'
        )
      })
    }, PROJECT_SYNC_POLL_INTERVAL_MS)
  }

  scheduleWorkspaceSync(session) {
    if (session.workspaceSyncTimer) {
      clearTimeout(session.workspaceSyncTimer)
    }

    session.workspaceSyncTimer = setTimeout(() => {
      session.workspaceSyncTimer = null
      this.syncWorkspaceToProject(session).catch(error => {
        logger.error(
          { projectId: session.projectId, error },
          'Failed to sync workspace changes back into project'
        )
      })
    }, WORKSPACE_SYNC_DEBOUNCE_MS)
  }

  isWorkspacePathIgnored(session, projectPath) {
    const ignoredUntil = session.ignoredWorkspacePaths.get(projectPath)
    if (!ignoredUntil) {
      return false
    }

    if (ignoredUntil <= Date.now()) {
      session.ignoredWorkspacePaths.delete(projectPath)
      return false
    }

    return true
  }

  markWorkspacePathIgnored(session, projectPath) {
    session.ignoredWorkspacePaths.set(
      projectPath,
      Date.now() + WORKSPACE_EVENT_IGNORE_MS
    )
  }

  async syncWorkspaceToProject(session) {
    if (session.workspaceSyncInProgress) {
      session.workspaceSyncQueued = true
      return
    }

    session.workspaceSyncInProgress = true

    try {
      const workspaceDocs = await this.readWorkspaceDocs(session)
      const workspacePaths = new Set(workspaceDocs.keys())

      for (const [projectPath, content] of workspaceDocs.entries()) {
        if (session.pendingProjectSyncs.has(projectPath)) {
          continue
        }
        if (session.docStates.get(projectPath) === content) {
          continue
        }

        await this.pushWorkspaceDocToProject(session, projectPath, content)
      }

      for (const projectPath of Array.from(session.docStates.keys())) {
        if (workspacePaths.has(projectPath) || session.pendingProjectSyncs.has(projectPath)) {
          continue
        }

        await this.deleteProjectDocFromWorkspace(session, projectPath)
      }
    } finally {
      session.workspaceSyncInProgress = false
      if (session.workspaceSyncQueued) {
        session.workspaceSyncQueued = false
        this.scheduleWorkspaceSync(session)
      }
    }
  }

  async syncProjectToWorkspace(session) {
    if (session.projectSyncInProgress) {
      return
    }

    session.projectSyncInProgress = true

    try {
      const workspace = await AIService.getWorkspaceSnapshot(session.projectId)
      const latestDocStates = new Map(
        workspace.docs.map(doc => [
          this.normalizeProjectPath(doc.path),
          normalizeContent(doc.content),
        ])
      )

      session.binaryPaths = new Set(
        workspace.files.map(file => this.normalizeProjectPath(file.path))
      )

      for (const [projectPath, content] of latestDocStates.entries()) {
        if (session.pendingProjectSyncs.has(projectPath)) {
          continue
        }
        if (session.docStates.get(projectPath) === content) {
          continue
        }

        await this.writeDocToWorkspace(session, projectPath, content)
      }

      for (const projectPath of Array.from(session.docStates.keys())) {
        if (latestDocStates.has(projectPath) || session.pendingProjectSyncs.has(projectPath)) {
          continue
        }

        await this.removeDocFromWorkspace(session, projectPath)
      }
    } finally {
      session.projectSyncInProgress = false
    }
  }

  async readWorkspaceDocs(session) {
    const docs = new Map()

    const visitDirectory = async currentDir => {
      let entries
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return
        }
        throw error
      }

      for (const entry of entries) {
        const entryPath = path.join(currentDir, entry.name)

        if (entry.isDirectory()) {
          await visitDirectory(entryPath)
          continue
        }

        if (!entry.isFile()) {
          continue
        }

        const projectPath = this.getProjectPath(session.workDir, entryPath)
        if (
          session.binaryPaths.has(projectPath) ||
          IGNORED_WORKSPACE_PATHS.has(projectPath)
        ) {
          continue
        }

        let buffer
        try {
          buffer = await fs.readFile(entryPath)
        } catch (error) {
          if (error?.code === 'ENOENT') {
            continue
          }
          throw error
        }
        if (this.isBinaryBuffer(buffer)) {
          continue
        }

        docs.set(projectPath, normalizeContent(buffer.toString('utf-8')))
      }
    }

    await visitDirectory(session.workDir)

    return docs
  }

  isBinaryBuffer(buffer) {
    return buffer.includes(0)
  }

  async pushWorkspaceDocToProject(session, projectPath, content) {
    session.pendingProjectSyncs.add(projectPath)

    try {
      await EditorController.promises.upsertDocWithPath(
        session.projectId,
        projectPath,
        contentToLines(content),
        TERMINAL_SYNC_SOURCE,
        session.userId
      )
      session.docStates.set(projectPath, content)
      logger.info(
        { projectId: session.projectId, projectPath },
        'Synced terminal workspace doc into project'
      )
    } catch (error) {
      logger.error(
        { projectId: session.projectId, projectPath, error },
        'Failed to sync terminal workspace doc into project'
      )
    } finally {
      session.pendingProjectSyncs.delete(projectPath)
    }
  }

  async deleteProjectDocFromWorkspace(session, projectPath) {
    session.pendingProjectSyncs.add(projectPath)

    try {
      await EditorController.promises.deleteEntityWithPath(
        session.projectId,
        projectPath,
        TERMINAL_SYNC_SOURCE,
        session.userId
      )
      session.docStates.delete(projectPath)
      logger.info(
        { projectId: session.projectId, projectPath },
        'Deleted project doc after terminal workspace removal'
      )
    } catch (error) {
      logger.error(
        { projectId: session.projectId, projectPath, error },
        'Failed to delete project doc after terminal workspace removal'
      )
    } finally {
      session.pendingProjectSyncs.delete(projectPath)
    }
  }

  async writeDocToWorkspace(session, projectPath, content) {
    const workspacePath = this.getWorkspacePath(session.workDir, projectPath)
    this.markWorkspacePathIgnored(session, projectPath)
    session.docStates.set(projectPath, content)

    await fs.mkdir(path.dirname(workspacePath), { recursive: true })
    await fs.writeFile(workspacePath, content, 'utf-8')
  }

  async removeDocFromWorkspace(session, projectPath) {
    const workspacePath = this.getWorkspacePath(session.workDir, projectPath)
    this.markWorkspacePathIgnored(session, projectPath)
    session.docStates.delete(projectPath)

    await fs.rm(workspacePath, { force: true })
    await this.removeEmptyParentDirectories(session.workDir, path.dirname(workspacePath))
  }

  async removeEmptyParentDirectories(workDir, currentDir) {
    while (currentDir !== workDir && currentDir.startsWith(workDir)) {
      let entries
      try {
        entries = await fs.readdir(currentDir)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          currentDir = path.dirname(currentDir)
          continue
        }
        throw error
      }
      if (entries.length > 0) {
        return
      }

      try {
        await fs.rmdir(currentDir)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          currentDir = path.dirname(currentDir)
          continue
        }
        throw error
      }
      currentDir = path.dirname(currentDir)
    }
  }
}

export default new ClaudeCodeService()
