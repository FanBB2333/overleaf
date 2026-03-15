import OLButton from '@/shared/components/ol/ol-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import MaterialIcon from '@/shared/components/material-icon'
import getMeta from '@/utils/meta'

export function AIAssistantToggleButton() {
  const aiAssistant = getMeta('ol-aiAssistant')

  if (!aiAssistant?.enabled) {
    return null
  }

  return (
    <OLTooltip
      id="open-ai-assistant"
      overlayProps={{ placement: 'top' }}
      description="AI Assistant"
    >
      <OLButton
        variant="ghost"
        size="sm"
        onClick={() => window.dispatchEvent(new Event('ai-assistant:toggle'))}
      >
        <MaterialIcon
          type="smart_toy"
          accessibilityLabel="Open AI assistant"
        />
      </OLButton>
    </OLTooltip>
  )
}
