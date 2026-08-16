#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function combination(n, k) {
  if (k < 0 || k > n) return 0
  let value = 1
  const count = Math.min(k, n - k)
  for (let index = 1; index <= count; index += 1) value = value * (n - count + index) / index
  return value
}

function fisherTwoSided(a, b, c, d) {
  const firstTotal = a + b
  const successes = a + c
  const total = a + b + c + d
  const probability = x => combination(successes, x)
    * combination(total - successes, firstTotal - x)
    / combination(total, firstTotal)
  const observed = probability(a)
  const low = Math.max(0, firstTotal - (total - successes))
  const high = Math.min(firstTotal, successes)
  let result = 0
  for (let x = low; x <= high; x += 1) {
    const candidate = probability(x)
    if (candidate <= observed + 1e-12) result += candidate
  }
  return Math.min(1, result)
}

function wilson(successes, total, z = 1.959963984540054) {
  const p = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const center = (p + z2 / (2 * total)) / denominator
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator
  return { low: center - half, high: center + half }
}

function factor(row) {
  const match = /^schema-factor-(persistent|oneshot)-(editor|read)$/.exec(row.strategy)
  if (match === null) throw new Error(`unexpected factorial strategy ${row.strategy}`)
  return { shell: match[1], file: match[2] }
}

function group(rows) {
  const successes = rows.filter(row => row.classification.label === 'minimal-like').length
  return {
    successes,
    total: rows.length,
    rate: successes / rows.length,
    wilson95: wilson(successes, rows.length),
    validFirstAction: rows.filter(row => row.validFirstAction).length,
    dispatchPrevented: rows.filter(row => row.dispatchPrevented).length,
    meanPromptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0) / rows.length,
    meanReasoningTokens: rows.reduce((sum, row) => sum + row.reasoningTokens, 0) / rows.length,
  }
}

function effect(left, right) {
  const a = group(left)
  const b = group(right)
  return {
    left: a,
    right: b,
    riskDifference: a.rate - b.rate,
    fisherTwoSided: fisherTwoSided(a.successes, a.total - a.successes, b.successes, b.total - b.successes),
  }
}

function validateRows(rows) {
  if (rows.length === 0) throw new Error('factorial input contains no rows')

  const sessions = rows.map(row => row.sessionIdSha256)
  if (sessions.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new Error('every factorial row must include sessionIdSha256')
  }
  if (new Set(sessions).size !== sessions.length) {
    throw new Error('factorial input contains duplicate session ids')
  }

  const observationKeys = rows.map(row => `${row.task}\u0000${row.strategy}\u0000${row.repetition}`)
  if (new Set(observationKeys).size !== observationKeys.length) {
    throw new Error('factorial input contains duplicate task/strategy/repetition observations')
  }

  const tasks = [...new Set(rows.map(row => row.task))]
  const cellSizes = {}
  for (const task of tasks) {
    const taskRows = rows.filter(row => row.task === task)
    const cells = new Map()
    for (const row of taskRows) {
      const key = `${row.shell}/${row.file}`
      cells.set(key, (cells.get(key) ?? 0) + 1)
    }
    const expected = ['persistent/editor', 'persistent/read', 'oneshot/editor', 'oneshot/read']
    if (expected.some(key => !cells.has(key)) || cells.size !== expected.length) {
      throw new Error(`task ${JSON.stringify(task)} does not contain the complete 2x2 matrix`)
    }
    const sizes = expected.map(key => cells.get(key))
    if (new Set(sizes).size !== 1) {
      throw new Error(`task ${JSON.stringify(task)} has unbalanced factorial cells: ${sizes.join(',')}`)
    }
    cellSizes[task] = Object.fromEntries(expected.map(key => [key, cells.get(key)]))
  }

  return {
    rows: rows.length,
    uniqueSessions: new Set(sessions).size,
    uniqueObservationKeys: new Set(observationKeys).size,
    balancedCompleteMatrixPerTask: true,
    cellSizes,
  }
}

const args = process.argv.slice(2)
const inputAt = args.indexOf('--input')
const outAt = args.indexOf('--out')
if (inputAt < 0 || outAt < 0 || args[inputAt + 1] === undefined || args[outAt + 1] === undefined) {
  throw new Error('usage: summarize-factorial --input trajectories.json --out report.json')
}
const input = JSON.parse(await readFile(resolve(args[inputAt + 1]), 'utf8'))
const rows = input.rows.map(row => ({ ...row, ...factor(row) }))
const integrity = validateRows(rows)
const tasks = [...new Set(rows.map(row => row.task))]
const scopes = { overall: rows, ...Object.fromEntries(tasks.map(task => [task, rows.filter(row => row.task === task)])) }

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  includedTrajectories: rows.length,
  integrity,
  cells: Object.fromEntries(tasks.flatMap(task => ['persistent', 'oneshot'].flatMap(shell => ['editor', 'read'].map(file => [
    `${task}/${shell}/${file}`,
    group(rows.filter(row => row.task === task && row.shell === shell && row.file === file)),
  ])))),
  effects: Object.fromEntries(Object.entries(scopes).map(([scope, scoped]) => [scope, {
    shellPersistentVsOneshot: effect(
      scoped.filter(row => row.shell === 'persistent'),
      scoped.filter(row => row.shell === 'oneshot'),
    ),
    fileEditorVsRead: effect(
      scoped.filter(row => row.file === 'editor'),
      scoped.filter(row => row.file === 'read'),
    ),
    cornerPersistentEditorVsOneshotRead: effect(
      scoped.filter(row => row.shell === 'persistent' && row.file === 'editor'),
      scoped.filter(row => row.shell === 'oneshot' && row.file === 'read'),
    ),
  }])),
  classifierLabels: Object.fromEntries(['minimal-like', 'standard-like', 'ambiguous'].map(label => {
    const subset = rows.filter(row => row.classification.label === label)
    return [label, { total: subset.length, validFirstAction: subset.filter(row => row.validFirstAction).length }]
  })),
  rows,
}

await writeFile(resolve(args[outAt + 1]), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
