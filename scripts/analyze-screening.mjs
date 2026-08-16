#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { classifyReasoning } from '../../modeltest/evaluator/trigger_probe/src/classifier.mjs'

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function wilson(successes, total, z = 1.959963984540054) {
  if (total === 0) return null
  const p = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const center = (p + z2 / (2 * total)) / denominator
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator
  return { low: center - half, high: center + half }
}

function combination(n, k) {
  if (k < 0 || k > n) return 0
  let result = 1
  const count = Math.min(k, n - k)
  for (let index = 1; index <= count; index += 1) result = result * (n - count + index) / index
  return result
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
  let p = 0
  for (let x = low; x <= high; x += 1) {
    const candidate = probability(x)
    if (candidate <= observed + 1e-12) p += candidate
  }
  return Math.min(1, p)
}

function parseArguments(block) {
  try {
    JSON.parse(block.arguments.text)
    return true
  } catch {
    return false
  }
}

function trajectoryRow(task, source, record) {
  const assistant = record.runtime?.assistantMessages?.[0]
  if (assistant === undefined) return null
  const blocks = assistant.blocks ?? []
  const reasoning = blocks.filter(block => block.type === 'reasoning').map(block => block.text).join('')
  const firstToolIndex = blocks.findIndex(block => block.type === 'tool-call')
  const visibleBeforeTool = blocks.slice(0, firstToolIndex < 0 ? blocks.length : firstToolIndex)
    .some(block => block.type === 'text' && block.text.trim() !== '')
  const classification = classifyReasoning(reasoning, visibleBeforeTool)
  const toolCalls = blocks.filter(block => block.type === 'tool-call')
  const availableTools = new Set(record.runtime.requests[0].toolNames)
  const toolResults = record.runtime.toolResults ?? []
  const validFirstAction = toolCalls.length > 0
    && toolCalls[0].name === 'bash'
    && toolCalls.every(block => availableTools.has(block.name) && parseArguments(block))
  const dispatchPrevented = toolResults.length === toolCalls.length
    && toolResults.every(result => result.error?.code === 'ABORTED_BEFORE_DISPATCH')
  const usage = assistant.usage ?? {}
  return {
    task,
    source,
    sequence: record.run.sequence,
    repetition: record.run.config.repetition,
    strategy: record.run.config.strategy,
    anonymousUserIdSha256: record.run.anonymousUserIdSha256,
    sessionIdSha256: record.runtime.sessionIdSha256,
    classification,
    startsWeNeed: /^we need\b/i.test(reasoning.trim()),
    startsLetMe: /^let me\b/i.test(reasoning.trim()),
    reasoningChars: reasoning.length,
    reasoningTokens: usage.reasoningTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    promptTokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    latencyMs: assistant.time - record.runtime.requests[0].time,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls.map(block => block.name),
    validFirstAction,
    dispatchPrevented,
    systemSha256: record.runtime.requests[0].system.sha256,
    toolSchemaSha256: record.runtime.requests[0].tools.map(tool => tool.schemaSha256),
  }
}

function summarize(rows) {
  const labels = { 'minimal-like': 0, 'standard-like': 0, ambiguous: 0 }
  for (const row of rows) labels[row.classification.label] += 1
  const minimalLike = labels['minimal-like']
  return {
    n: rows.length,
    labels,
    minimalLikeRate: rows.length === 0 ? null : minimalLike / rows.length,
    minimalLikeWilson95: wilson(minimalLike, rows.length),
    startsWeNeed: rows.filter(row => row.startsWeNeed).length,
    startsLetMe: rows.filter(row => row.startsLetMe).length,
    validFirstAction: rows.filter(row => row.validFirstAction).length,
    dispatchPrevented: rows.filter(row => row.dispatchPrevented).length,
    meanReasoningTokens: mean(rows.map(row => row.reasoningTokens)),
    meanOutputTokens: mean(rows.map(row => row.outputTokens)),
    meanPromptTokens: mean(rows.map(row => row.promptTokens)),
    meanLatencyMs: mean(rows.map(row => row.latencyMs)),
    meanToolCalls: mean(rows.map(row => row.toolCallCount)),
    anonymousIdentityBlocks: [...new Set(rows.map(row => row.anonymousUserIdSha256))].length,
    systemHashes: [...new Set(rows.map(row => row.systemSha256))],
    toolSchemaSurfaces: [...new Set(rows.map(row => row.toolSchemaSha256.join(',')))],
  }
}

function comparison(rows) {
  const exactRows = rows.filter(row => row.strategy === 'minimal')
  const legacyRows = rows.filter(row => row.strategy === 'historical-anchored')
  const exactSuccess = exactRows.filter(row => row.classification.label === 'minimal-like').length
  const legacySuccess = legacyRows.filter(row => row.classification.label === 'minimal-like').length
  return {
    exactMinimal: {
      successes: exactSuccess,
      total: exactRows.length,
      rate: exactSuccess / exactRows.length,
      wilson95: wilson(exactSuccess, exactRows.length),
    },
    bashReadSurrogate: {
      successes: legacySuccess,
      total: legacyRows.length,
      rate: legacySuccess / legacyRows.length,
      wilson95: wilson(legacySuccess, legacyRows.length),
    },
    riskDifference: exactSuccess / exactRows.length - legacySuccess / legacyRows.length,
    fisherTwoSided: fisherTwoSided(
      exactSuccess,
      exactRows.length - exactSuccess,
      legacySuccess,
      legacyRows.length - legacySuccess,
    ),
  }
}

function parseArgs(argv) {
  const inputs = []
  let out
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      out = resolve(argv[++index])
      continue
    }
    const split = argv[index].indexOf('=')
    if (split < 1) throw new Error('inputs must be TASK=DIR')
    inputs.push({ task: argv[index].slice(0, split), dir: resolve(argv[index].slice(split + 1)) })
  }
  if (inputs.length === 0) throw new Error('provide at least one TASK=DIR input')
  return { inputs, out }
}

const { inputs, out } = parseArgs(process.argv.slice(2))
const rows = []
for (const input of inputs) {
  for (const name of (await readdir(input.dir)).filter(name => /^\d{4}-.+\.json$/.test(name)).sort()) {
    const record = JSON.parse(await readFile(resolve(input.dir, name), 'utf8'))
    const row = trajectoryRow(input.task, input.dir, record)
    if (row !== null) rows.push(row)
  }
}

const tasks = [...new Set(rows.map(row => row.task))]
const strategies = [...new Set(rows.map(row => row.strategy))]
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  includedTrajectories: rows.length,
  groups: Object.fromEntries(tasks.flatMap(task => strategies.map(strategy => {
    const group = rows.filter(row => row.task === task && row.strategy === strategy)
    return [`${task}/${strategy}`, summarize(group)]
  }))),
  overallGroups: Object.fromEntries(strategies.map(strategy => [
    strategy,
    summarize(rows.filter(row => row.strategy === strategy)),
  ])),
  comparisons: {
    ...Object.fromEntries(tasks.map(task => [task, comparison(rows.filter(row => row.task === task))])),
    overall: comparison(rows),
  },
  labelVsFirstAction: Object.fromEntries(['minimal-like', 'standard-like', 'ambiguous'].map(label => {
    const group = rows.filter(row => row.classification.label === label)
    return [label, { n: group.length, validFirstAction: group.filter(row => row.validFirstAction).length }]
  })),
  rows,
}

const serialized = JSON.stringify(report, null, 2) + '\n'
if (out === undefined) process.stdout.write(serialized)
else await writeFile(out, serialized, { mode: 0o600 })
