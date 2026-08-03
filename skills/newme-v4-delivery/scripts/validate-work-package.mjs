#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const SHA = /^[0-9a-f]{40}$/
const LINEAR = /^SAM-(\d+)$/
const V4 = /^V4-(?:PF|RE|RT|AI|INT|OPS|MIG|PILOT)-(\d{3})$/
const HOMOGENEOUS_SHA = /^([0-9a-f])\1{39}$/

function fail(message) {
  console.error(`V4_WORK_PACKAGE_INVALID: ${message}`)
  process.exit(1)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
}

const path = process.argv[2]
if (!path) fail('usage: validate-work-package.mjs <manifest.json>')

let value
try {
  value = JSON.parse(await readFile(path, 'utf8'))
} catch (error) {
  fail(`cannot parse JSON: ${error instanceof Error ? error.message : 'unknown error'}`)
}

const linearMatch = LINEAR.exec(value.linearId ?? '')
if (!linearMatch || Number(linearMatch[1]) < 77) fail('linearId must match a non-placeholder SAM-N with N >= 77')
if (!nonEmptyStrings(value.v4Ids) || !value.v4Ids.every((id) => {
  const match = V4.exec(id)
  return match && Number(match[1]) > 0
})) {
  fail('v4Ids must contain valid V4 requirement IDs')
}
if (!SHA.test(value.baseSha ?? '') || HOMOGENEOUS_SHA.test(value.baseSha)) {
  fail('baseSha must be a non-placeholder lowercase 40-character Git SHA')
}
if (!nonEmptyStrings(value.allowedPaths)) fail('allowedPaths must be non-empty strings')
if (!nonEmptyString(value.outcome)) fail('outcome is required')
if (!nonEmptyStrings(value.nonGoals)) fail('nonGoals must be explicit')
if (!nonEmptyString(value.dataSecurityImpact)) fail('dataSecurityImpact is required')
if (!nonEmptyStrings(value.validation)) fail('validation must contain executable checks')
if (!nonEmptyString(value.risk)) fail('risk is required')
if (!nonEmptyString(value.rollback)) fail('rollback is required')

console.log(`V4 work package valid: ${value.linearId} (${value.v4Ids.join(', ')})`)
