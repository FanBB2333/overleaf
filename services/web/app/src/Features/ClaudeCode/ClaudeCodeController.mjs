import ClaudeCodeService from './ClaudeCodeService.mjs'
import SessionManager from '../Authentication/SessionManager.mjs'
import logger from '@overleaf/logger'

export default {
  async createSession(req, res) {
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)

    try {
      const session = await ClaudeCodeService.createSession(projectId, userId)
      res.json({
        success: true,
        workDir: session.workDir,
      })
    } catch (error) {
      logger.error({ projectId, userId, error }, 'Failed to create Claude Code session')
      res.status(500).json({
        success: false,
        error: error.message,
      })
    }
  },

  async destroySession(req, res) {
    const projectId = req.params.Project_id

    try {
      await ClaudeCodeService.destroySession(projectId)
      res.json({ success: true })
    } catch (error) {
      logger.error({ projectId, error }, 'Failed to destroy Claude Code session')
      res.status(500).json({
        success: false,
        error: error.message,
      })
    }
  },

  async getStatus(req, res) {
    const projectId = req.params.Project_id
    const session = ClaudeCodeService.getSession(projectId)

    res.json({
      active: !!session,
      connections: session ? session.connections.size : 0,
    })
  },
}
