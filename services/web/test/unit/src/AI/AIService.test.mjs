import { expect, vi } from 'vitest'

const MODULE_PATH = '../../../../app/src/Features/AI/AIService.mjs'

describe('AIService', function () {
  beforeEach(async function (ctx) {
    vi.resetModules()

    ctx.project = {
      _id: 'project-1',
      rootFolder: [{ _id: 'folder-1' }],
      rootDoc_id: 'doc-1',
    }

    ctx.Settings = {
      aiAssistant: {
        enabled: true,
        provider: 'codex',
        bridgeUrl: 'http://127.0.0.1:8787',
        localBridge: true,
      },
    }

    ctx.ProjectGetter = {
      promises: {
        getProject: vi.fn().mockResolvedValue(ctx.project),
      },
    }

    ctx.ProjectEntityHandler = {
      getAllDocPathsFromProject: vi
        .fn()
        .mockReturnValue({ 'doc-1': '/main.tex' }),
      promises: {
        getAllFiles: vi.fn().mockResolvedValue({
          '/images/plot.png': { _id: 'file-1' },
        }),
      },
    }

    ctx.DocumentUpdaterHandler = {
      promises: {
        getProjectDocsIfMatch: vi.fn().mockResolvedValue([
          {
            _id: 'doc-1',
            lines: ['Hello', 'world'],
            v: 12,
          },
        ]),
        getDocument: vi.fn(),
      },
    }

    ctx.ProjectEntityUpdateHandler = {
      promises: {
        upsertDocWithPath: vi.fn().mockResolvedValue({
          doc: { _id: 'doc-1' },
          isNew: false,
        }),
        deleteEntityWithPath: vi.fn().mockResolvedValue(),
      },
    }

    ctx.ClsiStateManager = {
      computeHash: vi.fn().mockReturnValue('snapshot-1'),
    }

    vi.doMock('@overleaf/settings', () => ({
      default: ctx.Settings,
    }))
    vi.doMock('../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
      default: ctx.ProjectGetter,
    }))
    vi.doMock(
      '../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
      () => ({
        default: ctx.ProjectEntityHandler,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
      () => ({
        default: ctx.DocumentUpdaterHandler,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Project/ProjectEntityUpdateHandler.mjs',
      () => ({
        default: ctx.ProjectEntityUpdateHandler,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Compile/ClsiStateManager.mjs',
      () => ({
        default: ctx.ClsiStateManager,
      })
    )

    ctx.AIService = (await import(MODULE_PATH)).default
  })

  afterEach(function () {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('builds workspace snapshots from the current doc updater view', async function (ctx) {
    const snapshot = await ctx.AIService.getWorkspaceSnapshot('project-1')

    expect(snapshot).to.deep.equal({
      projectId: 'project-1',
      rootDocId: 'doc-1',
      snapshotVersion: 'snapshot-1',
      docs: [
        {
          docId: 'doc-1',
          path: '/main.tex',
          version: 12,
          content: 'Hello\nworld',
        },
      ],
      files: [
        {
          fileId: 'file-1',
          path: '/images/plot.png',
          kind: 'binary',
          downloadUrl: '/Project/project-1/file/file-1',
        },
      ],
    })
    expect(
      ctx.DocumentUpdaterHandler.promises.getProjectDocsIfMatch
    ).toHaveBeenCalledWith('project-1', 'snapshot-1')
    expect(ctx.DocumentUpdaterHandler.promises.getDocument).not.toHaveBeenCalled()
  })

  it('rejects apply when the doc base version is stale', async function (ctx) {
    const result = await ctx.AIService.applyWorkspaceChanges(
      'project-1',
      'user-1',
      {
        baseSnapshotVersion: 'snapshot-1',
        updates: [
          {
            path: '/main.tex',
            baseVersion: 3,
            content: 'Updated content',
          },
        ],
      }
    )

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      message: 'change set validation failed',
      errors: [
        expect.objectContaining({
          path: '/main.tex',
          code: 'version-conflict',
          expectedVersion: 12,
          baseVersion: 3,
        }),
      ],
    })
    expect(
      ctx.ProjectEntityUpdateHandler.promises.upsertDocWithPath
    ).not.toHaveBeenCalled()
  })

  it('applies valid doc updates through the project entity update handler', async function (ctx) {
    const result = await ctx.AIService.applyWorkspaceChanges(
      'project-1',
      'user-1',
      {
        baseSnapshotVersion: 'snapshot-1',
        updates: [
          {
            path: '/main.tex',
            baseVersion: 12,
            content: 'Updated content',
          },
        ],
      }
    )

    expect(result).toMatchObject({
      ok: true,
      source: 'ai-bridge',
      applied: [
        {
          path: '/main.tex',
          action: 'update',
          status: 'applied',
          docId: 'doc-1',
        },
      ],
    })
    expect(
      ctx.ProjectEntityUpdateHandler.promises.upsertDocWithPath
    ).toHaveBeenCalledWith(
      'project-1',
      '/main.tex',
      ['Updated content'],
      'ai-bridge',
      'user-1'
    )
  })

  it('deletes docs through the project entity update handler with the correct argument order', async function (ctx) {
    const result = await ctx.AIService.applyWorkspaceChanges(
      'project-1',
      'user-1',
      {
        baseSnapshotVersion: 'snapshot-1',
        updates: [
          {
            path: '/main.tex',
            delete: true,
          },
        ],
      }
    )

    expect(result).toMatchObject({
      ok: true,
      source: 'ai-bridge',
      applied: [
        {
          path: '/main.tex',
          action: 'delete',
          status: 'applied',
          docId: 'doc-1',
        },
      ],
    })
    expect(
      ctx.ProjectEntityUpdateHandler.promises.deleteEntityWithPath
    ).toHaveBeenCalledWith('project-1', '/main.tex', 'user-1', 'ai-bridge')
  })
})
