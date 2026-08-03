#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const FORBIDDEN_KEY = /(?:password|passwd|secret|token|cookie|authorization|service[_-]?key|dsn)/i

function fail(message) {
  console.error(`V4_RELEASE_EVIDENCE_INVALID: ${message}`)
  process.exit(1)
}

function scan(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => scan(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) fail(`forbidden secret-shaped field at ${path}.${key}`)
    scan(child, `${path}.${key}`)
  }
}

const path = process.argv[2]
if (!path) fail('usage: validate-release-evidence.mjs <evidence.json>')

let value
try {
  value = JSON.parse(await readFile(path, 'utf8'))
} catch (error) {
  fail(`cannot parse JSON: ${error instanceof Error ? error.message : 'unknown error'}`)
}

scan(value)
if (!SHA.test(value.candidateSha ?? '')) fail('candidateSha must be a lowercase 40-character Git SHA')
if (!SHA.test(value.previousReleaseSha ?? '')) fail('previousReleaseSha must be a lowercase 40-character Git SHA')
if (!value.environment?.id || !value.environment?.name) fail('environment id and name are required')
if (value.ci?.headSha !== value.candidateSha || value.ci?.status !== 'success' || !value.ci?.runUrl) {
  fail('exact-head successful CI evidence is required')
}
if (!SHA256.test(value.artifact?.sha256 ?? '')) fail('artifact sha256 is required')
if (value.manifest?.gitSha !== value.candidateSha) fail('manifest must bind the candidate SHA')
if (value.health?.staging !== 'ok' || value.health?.production !== 'unchanged-ok') {
  fail('staging and unchanged production health are required')
}
if (value.migrations?.status !== 'verified') fail('migration status must be verified')
if (value.uat?.status !== 'success' || !Array.isArray(value.uat?.checks) || value.uat.checks.length === 0) {
  fail('successful non-empty UAT evidence is required')
}
if (value.cleanup?.status !== 'verified' || !value.cleanup?.counts) fail('verified cleanup counts are required')
for (const [name, count] of Object.entries(value.cleanup.counts)) {
  if (!Number.isInteger(count) || count !== 0) fail(`cleanup residue is non-zero or invalid for ${name}`)
}
if (value.rollback?.status !== 'ready' || value.rollback?.targetSha !== value.previousReleaseSha) {
  fail('rollback must be ready and target the direct predecessor')
}

console.log(`V4 release evidence valid: ${value.candidateSha} on ${value.environment.id}`)
