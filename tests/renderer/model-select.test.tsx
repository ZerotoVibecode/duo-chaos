// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelSelect } from '../../src/renderer/src/components/ModelSelect'
import { AgentLoadoutPanel } from '../../src/renderer/src/components/AgentLoadoutPanel'
import { defaultSettings } from '../../src/main/settings/settings-store'
import type { AgentModelCapability } from '../../src/shared/types'

const sol: AgentModelCapability = { id: 'gpt-5.6-sol', label: 'Sol', efforts: ['low', 'ultra'] }
const luna: AgentModelCapability = { id: 'gpt-5.6-luna', label: 'Luna', efforts: ['low', 'max'] }

describe('ModelSelect catalog refreshes', () => {
  afterEach(() => cleanup())

  it('moves between known and custom mode when the local CLI catalog changes', () => {
    const onChange = vi.fn()
    const view = render(<ModelSelect label="Codex model" value={sol.id} suggestions={[sol]} fieldClassName="field" onChange={onChange} />)
    expect(screen.queryByLabelText(/custom model id/i)).not.toBeInTheDocument()

    view.rerender(<ModelSelect label="Codex model" value={sol.id} suggestions={[luna]} fieldClassName="field" onChange={onChange} />)
    expect(screen.getByLabelText(/custom model id/i)).toHaveValue(sol.id)

    view.rerender(<ModelSelect label="Codex model" value={sol.id} suggestions={[sol, luna]} fieldClassName="field" onChange={onChange} />)
    expect(screen.queryByLabelText(/custom model id/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Codex model')).toHaveValue(sol.id)

    view.rerender(<ModelSelect label="Codex model" value="future-model" suggestions={[sol, luna]} fieldClassName="field" onChange={onChange} />)
    expect(screen.getByLabelText(/custom model id/i)).toHaveValue('future-model')
    view.rerender(<ModelSelect label="Codex model" value="" suggestions={[sol, luna]} fieldClassName="field" onChange={onChange} />)
    expect(screen.queryByLabelText(/custom model id/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Codex model')).toHaveValue('')
  })

  it('synchronizes the launch draft when settings are saved elsewhere', () => {
    const base = defaultSettings('C:\\DuoChaos\\workspaces')
    const props = {
      health: [],
      busy: false,
      onRefresh: vi.fn(),
      onSave: vi.fn().mockResolvedValue(undefined),
      onOpenAgentCli: vi.fn().mockResolvedValue(undefined)
    }
    const view = render(<AgentLoadoutPanel {...props} settings={base} />)
    expect(screen.getByLabelText('Codex model')).toHaveValue('')

    view.rerender(<AgentLoadoutPanel {...props} settings={{ ...base, codexModel: 'gpt-5.6-terra', codexEffort: 'low' }} />)

    expect(screen.getByLabelText('Codex model')).toHaveValue('gpt-5.6-terra')
    expect(screen.getByLabelText('Codex effort')).toHaveValue('low')
    expect(screen.getByRole('button', { name: /loadout applied/i })).toBeDisabled()
  })
})
