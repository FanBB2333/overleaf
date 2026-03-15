import { expressify } from '@overleaf/promise-utils'
import Features from '../../infrastructure/Features.mjs'
import SessionManager from '../Authentication/SessionManager.mjs'
import AIService from './AIService.mjs'

async function getWorkspace(req, res) {
  if (!Features.hasFeature('ai-assistant')) {
    return res.sendStatus(404)
  }

  const projectId = req.params.Project_id
  const workspace = await AIService.getWorkspaceSnapshot(projectId)
  res.json(workspace)
}

async function applyChanges(req, res) {
  if (!Features.hasFeature('ai-assistant')) {
    return res.sendStatus(404)
  }

  const projectId = req.params.Project_id
  const userId = SessionManager.getLoggedInUserId(req.session)
  const result = await AIService.applyWorkspaceChanges(
    projectId,
    userId,
    req.body
  )

  res.status(result.httpStatus || 200).json(result)
}

export default {
  applyChanges: expressify(applyChanges),
  getWorkspace: expressify(getWorkspace),
}
