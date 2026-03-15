import { lazy, memo, Suspense, useCallback, useState } from 'react'
import { FullSizeLoadingSpinner } from '../../../shared/components/loading-spinner'
import withErrorBoundary from '../../../infrastructure/error-boundary'
import { ErrorBoundaryFallback } from '../../../shared/components/error-boundary-fallback'
import getMeta from '@/utils/meta'
import useEventListener from '@/shared/hooks/use-event-listener'
import { AIAssistantPanel } from '@/features/ai-assistant/ai-assistant-panel'

const CodeMirrorEditor = lazy(
  () =>
    import(/* webpackChunkName: "codemirror-editor" */ './codemirror-editor')
)

function SourceEditor() {
  const aiAssistant = getMeta('ol-aiAssistant')
  const [isAIAssistantOpen, setIsAIAssistantOpen] = useState(false)

  const toggleAIAssistant = useCallback(() => {
    if (!aiAssistant?.enabled) {
      return
    }
    setIsAIAssistantOpen(open => !open)
  }, [aiAssistant])

  useEventListener('ai-assistant:toggle', toggleAIAssistant)

  return (
    <div className="ol-ai-assistant-shell">
      <div className="ol-ai-assistant-editor">
        <Suspense fallback={<FullSizeLoadingSpinner delay={500} />}>
          <CodeMirrorEditor />
        </Suspense>
      </div>
      <AIAssistantPanel
        open={isAIAssistantOpen}
        onClose={() => setIsAIAssistantOpen(false)}
      />
    </div>
  )
}

export default withErrorBoundary(memo(SourceEditor), () => (
  <ErrorBoundaryFallback />
))
