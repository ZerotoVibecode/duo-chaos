import type { ProviderRecord } from '@main/process/provider-envelope'

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function schemaToolNames(schema: Record<string, unknown>): Set<string> {
  const properties = recordOf(schema.properties)
  return new Set([
    'structuredoutput',
    ...Object.keys(properties ?? {}).map((name) => name.toLocaleLowerCase())
  ])
}

/**
 * Structured provider output may be assembled through an internal
 * `StructuredOutput` tool and, after a schema-validation retry, through tool
 * calls named after top-level schema fields. Those calls cannot touch the
 * workspace and must not be confused with Read/Edit/Bash or Codex execution
 * records. The child command still disables all real tools; this is the
 * evidence-side guard that catches a provider violating that boundary.
 */
export function containsStructuredWorkspaceActivity(
  records: ProviderRecord[],
  schema: Record<string, unknown>
): boolean {
  const protocolTools = schemaToolNames(schema)
  for (const record of records) {
    const item = recordOf(record.item)
    const itemType = stringOf(item?.type)?.toLocaleLowerCase()
    if (itemType && new Set([
      'command_execution',
      'file_change',
      'mcp_tool_call',
      'web_search',
      'computer_use'
    ]).has(itemType)) return true

    const message = recordOf(record.message)
    const content = Array.isArray(message?.content) ? message.content : []
    for (const value of content) {
      const block = recordOf(value)
      if (block?.type !== 'tool_use') continue
      const toolName = stringOf(block.name)?.toLocaleLowerCase()
      if (!toolName || !protocolTools.has(toolName)) return true
    }
  }
  return false
}
