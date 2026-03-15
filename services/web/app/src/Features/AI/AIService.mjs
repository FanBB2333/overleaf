import Settings from '@overleaf/settings'
import pLimit from 'p-limit'
import ClsiStateManager from '../Compile/ClsiStateManager.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import ProjectEntityUpdateHandler from '../Project/ProjectEntityUpdateHandler.mjs'
import ProjectGetter from '../Project/ProjectGetter.mjs'

const AI_SOURCE = 'ai-bridge'
const SNAPSHOT_CONCURRENCY = 4

function getPublicConfig() {
  return {
    enabled: Boolean(Settings.aiAssistant?.enabled),
    provider: Settings.aiAssistant?.provider || 'codex',
    bridgeUrl: Settings.aiAssistant?.bridgeUrl || null,
    localBridge: Boolean(Settings.aiAssistant?.localBridge),
    source: AI_SOURCE,
  }
}

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

function buildFileDownloadUrl(projectId, fileId) {
  return `/Project/${projectId}/file/${fileId}`
}

async function getWorkspaceSnapshot(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootFolder: 1,
    rootDoc_id: 1,
  })

  const snapshotVersion = ClsiStateManager.computeHash(project, {})
  const docPaths = ProjectEntityHandler.getAllDocPathsFromProject(project)
  const docs = await _getDocSnapshots(projectId, docPaths, snapshotVersion)
  const filesByPath = await ProjectEntityHandler.promises.getAllFiles(projectId)

  const files = Object.entries(filesByPath)
    .map(([path, file]) => ({
      fileId: file._id.toString(),
      path,
      kind: 'binary',
      downloadUrl: buildFileDownloadUrl(projectId, file._id),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))

  return {
    projectId,
    rootDocId: project.rootDoc_id?.toString() || null,
    snapshotVersion,
    docs,
    files,
  }
}

async function applyWorkspaceChanges(projectId, userId, changeSet = {}) {
  if (!userId) {
    return {
      ok: false,
      httpStatus: 401,
      message: 'login required',
    }
  }

  const updates = Array.isArray(changeSet.updates) ? changeSet.updates : null
  if (!updates || updates.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      message: 'updates must be a non-empty array',
    }
  }

  const duplicatePaths = findDuplicatePaths(updates)
  if (duplicatePaths.length > 0) {
    return {
      ok: false,
      httpStatus: 400,
      message: 'updates contain duplicate paths',
      duplicatePaths,
    }
  }

  const snapshot = await getWorkspaceSnapshot(projectId)
  if (
    changeSet.baseSnapshotVersion &&
    changeSet.baseSnapshotVersion !== snapshot.snapshotVersion
  ) {
    return {
      ok: false,
      httpStatus: 409,
      message: 'project structure changed, refresh workspace snapshot first',
      snapshotVersion: snapshot.snapshotVersion,
    }
  }

  const docsByPath = new Map(snapshot.docs.map(doc => [doc.path, doc]))
  const filesByPath = new Map(snapshot.files.map(file => [file.path, file]))
  const validationErrors = []

  for (const update of updates) {
    const path = update?.path
    const existingDoc = docsByPath.get(path)
    const existingFile = filesByPath.get(path)
    const isDelete = update?.delete === true

    if (typeof path !== 'string' || path.length === 0) {
      validationErrors.push({
        path: path || null,
        code: 'invalid-path',
        message: 'path is required',
      })
      continue
    }

    if (existingFile) {
      validationErrors.push({
        path,
        code: 'unsupported-file',
        message: 'AI apply only supports text docs in this MVP',
      })
      continue
    }

    if (existingDoc && update.baseVersion !== undefined) {
      if (update.baseVersion !== existingDoc.version) {
        validationErrors.push({
          path,
          code: 'version-conflict',
          message: 'document version changed, refresh workspace snapshot first',
          expectedVersion: existingDoc.version,
          baseVersion: update.baseVersion,
        })
      }
    }

    if (!isDelete && typeof update?.content !== 'string') {
      validationErrors.push({
        path,
        code: 'invalid-content',
        message: 'content must be a string for create/update operations',
      })
    }
  }

  if (validationErrors.length > 0) {
    return {
      ok: false,
      httpStatus: 409,
      message: 'change set validation failed',
      errors: validationErrors,
      snapshotVersion: snapshot.snapshotVersion,
    }
  }

  const results = []
  for (const update of updates) {
    if (update.delete === true) {
      const existingDoc = docsByPath.get(update.path)
      if (!existingDoc) {
        results.push({
          path: update.path,
          action: 'delete',
          status: 'skipped',
          reason: 'missing',
        })
        continue
      }

      await ProjectEntityUpdateHandler.promises.deleteEntityWithPath(
        projectId,
        update.path,
        userId,
        AI_SOURCE
      )

      results.push({
        path: update.path,
        action: 'delete',
        status: 'applied',
        docId: existingDoc.docId,
      })
      continue
    }

    const lines = contentToLines(update.content)
    const { doc, isNew } =
      await ProjectEntityUpdateHandler.promises.upsertDocWithPath(
        projectId,
        update.path,
        lines,
        AI_SOURCE,
        userId
      )

    results.push({
      path: update.path,
      action: isNew ? 'create' : 'update',
      status: 'applied',
      docId: doc._id?.toString() || doc._id,
    })
  }

  const updatedSnapshot = await getWorkspaceSnapshot(projectId)
  return {
    ok: true,
    source: AI_SOURCE,
    applied: results,
    snapshotVersion: updatedSnapshot.snapshotVersion,
  }
}

async function _getDocSnapshots(projectId, docPaths, snapshotVersion) {
  const docIds = Object.keys(docPaths)
  const docsFromDocUpdater =
    await DocumentUpdaterHandler.promises.getProjectDocsIfMatch(
      projectId,
      snapshotVersion
    )

  const docsById =
    docsFromDocUpdater && docsFromDocUpdater.length === docIds.length
      ? new Map(
          docsFromDocUpdater.map(doc => [
            doc._id.toString(),
            {
              version: doc.v,
              content: doc.lines.join('\n'),
            },
          ])
        )
      : await _getDocSnapshotsIndividually(projectId, docIds)

  return docIds
    .map(docId => ({
      docId,
      path: docPaths[docId],
      version: docsById.get(docId)?.version ?? 0,
      content: docsById.get(docId)?.content ?? '',
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

async function _getDocSnapshotsIndividually(projectId, docIds) {
  const limit = pLimit(SNAPSHOT_CONCURRENCY)
  const docs = await Promise.all(
    docIds.map(docId =>
      limit(async () => {
        const doc = await DocumentUpdaterHandler.promises.getDocument(
          projectId,
          docId,
          -1
        )
        return [
          docId,
          {
            version: doc.version,
            content: doc.lines.join('\n'),
          },
        ]
      })
    )
  )

  return new Map(docs)
}

function findDuplicatePaths(updates) {
  const seen = new Set()
  const duplicates = new Set()

  for (const update of updates) {
    if (typeof update?.path !== 'string') {
      continue
    }

    if (seen.has(update.path)) {
      duplicates.add(update.path)
    } else {
      seen.add(update.path)
    }
  }

  return Array.from(duplicates)
}

export default {
  AI_SOURCE,
  applyWorkspaceChanges,
  getPublicConfig,
  getWorkspaceSnapshot,
}
