import assert from 'node:assert/strict'
import test from 'node:test'
import { rankOptions } from './logic.js'

test('ranking is deterministic for a fixed decision sequence', () => {
  const options = ['Amber', 'Blue', 'Crimson']
  const choices = ['left', 'right', 'left']
  assert.deepEqual(rankOptions(options, choices), ['Amber', 'Blue', 'Crimson'])
  assert.deepEqual(rankOptions(options, choices), ['Amber', 'Blue', 'Crimson'])
})
