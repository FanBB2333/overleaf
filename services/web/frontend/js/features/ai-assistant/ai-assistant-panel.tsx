import { useCallback, useEffect, useState } from 'react'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'
import getMeta from '@/utils/meta'

type WorkspaceSnapshot = {
  snapshotVersion: string
  rootDocId: string | null
  docs: Array<{
    docId: string
    path: string
    version: number
    content: string
  }>
  files: Array<{
    fileId: string
    path: string
    kind: string
    downloadUrl: string
  }>
}

type Props = {
  open: boolean
  onClose: () => void
}

async function requestJson(url: string, options: RequestInit = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  const payload = text ? safeParseJson(text) : undefined

  if (!response.ok) {
    throw new Error(
      payload
        ? JSON.stringify(payload, null, 2)
        : `${response.status} ${response.statusText}`
    )
  }

  return payload
}

function safeParseJson(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function buildChangeSetTemplate(snapshot: WorkspaceSnapshot) {
  const primaryDoc = snapshot.docs[0]
  return JSON.stringify(
    {
      baseSnapshotVersion: snapshot.snapshotVersion,
      updates: primaryDoc
        ? [
            {
              path: primaryDoc.path,
              baseVersion: primaryDoc.version,
              content: '% Replace this content with the updated document text',
            },
          ]
        : [],
    },
    null,
    2
  )
}

export function AIAssistantPanel({ open, onClose }: Props) {
  const projectId = getMeta('ol-project_id')
  const csrfToken = getMeta('ol-csrfToken')
  const aiAssistant = getMeta('ol-aiAssistant')
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [snapshotText, setSnapshotText] = useState('')
  const [changeSetText, setChangeSetText] = useState('')
  const [resultText, setResultText] = useState('')
  const [errorText, setErrorText] = useState('')

  const loadSnapshot = useCallback(async () => {
    setIsLoadingSnapshot(true)
    setErrorText('')

    try {
      const snapshot = (await requestJson(
        `/project/${projectId}/ai/workspace`
      )) as WorkspaceSnapshot

      setSnapshotText(JSON.stringify(snapshot, null, 2))
      setChangeSetText(currentValue =>
        currentValue || buildChangeSetTemplate(snapshot)
      )
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to load')
    } finally {
      setIsLoadingSnapshot(false)
    }
  }, [projectId])

  const applyChangeSet = useCallback(async () => {
    setIsApplying(true)
    setErrorText('')

    try {
      const changeSet = JSON.parse(changeSetText)
      const result = await requestJson(`/project/${projectId}/ai/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken,
        },
        body: JSON.stringify(changeSet),
      })

      setResultText(JSON.stringify(result, null, 2))
      await loadSnapshot()
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to apply')
    } finally {
      setIsApplying(false)
    }
  }, [changeSetText, csrfToken, loadSnapshot, projectId])

  useEffect(() => {
    if (open && snapshotText === '' && !isLoadingSnapshot) {
      loadSnapshot().catch(() => {})
    }
  }, [isLoadingSnapshot, loadSnapshot, open, snapshotText])

  if (!open || !aiAssistant?.enabled) {
    return null
  }

  return (
    <aside className="ol-ai-assistant-panel" aria-label="AI Assistant">
      <div className="ol-ai-assistant-panel-header">
        <div>
          <div className="ol-ai-assistant-panel-kicker">AI Assistant</div>
          <h2 className="ol-ai-assistant-panel-title">{aiAssistant.provider}</h2>
        </div>
        <OLButton variant="ghost" size="sm" onClick={onClose}>
          <MaterialIcon type="close" accessibilityLabel="Close AI assistant" />
        </OLButton>
      </div>

      <div className="ol-ai-assistant-panel-body">
        <section className="ol-ai-assistant-section">
          <div className="ol-ai-assistant-section-header">
            <div>
              <h3>Workspace</h3>
              <p>
                Same-origin snapshot/apply API is ready. Bridge URL:{' '}
                {aiAssistant.bridgeUrl || 'not configured'}
              </p>
            </div>
            <OLButton
              variant="secondary"
              size="sm"
              onClick={loadSnapshot}
              disabled={isLoadingSnapshot}
            >
              {isLoadingSnapshot ? 'Refreshing…' : 'Refresh'}
            </OLButton>
          </div>
          <textarea
            className="ol-ai-assistant-textarea"
            value={snapshotText}
            readOnly
            placeholder="Workspace snapshot will appear here."
          />
        </section>

        <section className="ol-ai-assistant-section">
          <div className="ol-ai-assistant-section-header">
            <div>
              <h3>Apply Change Set</h3>
              <p>
                Paste a JSON payload with `baseSnapshotVersion` and `updates`.
              </p>
            </div>
            <OLButton
              variant="primary"
              size="sm"
              onClick={applyChangeSet}
              disabled={isApplying || changeSetText.trim() === ''}
            >
              {isApplying ? 'Applying…' : 'Apply'}
            </OLButton>
          </div>
          <textarea
            className="ol-ai-assistant-textarea ol-ai-assistant-textarea-editable"
            value={changeSetText}
            onChange={event => setChangeSetText(event.target.value)}
            placeholder='{"baseSnapshotVersion":"...","updates":[...]}'
          />
        </section>

        <section className="ol-ai-assistant-section">
          <div className="ol-ai-assistant-section-header">
            <div>
              <h3>Status</h3>
              <p>Last apply result or validation error.</p>
            </div>
          </div>
          {errorText ? (
            <div className="ol-ai-assistant-message ol-ai-assistant-message-error">
              {errorText}
            </div>
          ) : null}
          <textarea
            className="ol-ai-assistant-textarea"
            value={resultText}
            readOnly
            placeholder="Apply results will appear here."
          />
        </section>
      </div>
    </aside>
  )
}
