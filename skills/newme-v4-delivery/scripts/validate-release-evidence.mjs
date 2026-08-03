#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const MIGRATION_VERSION = /^\d{14}$/
const HOMOGENEOUS_HEX = /^([0-9a-f])\1+$/
const FORBIDDEN_KEY = /(?:password|passwd|passphrase|secret|token|cookie|authorization|bearer|(?:service|api|private|access)[_-]?key|credential|dsn|cert(?:ificate)?)/i
const FORBIDDEN_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]+=*|-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----|\b(?:ghp_|github_pat_|sb_secret_|AKIA)[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@|\b(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential)\s*[=:]\s*\S+)/i

function fail(message) {
  console.error(`V4_RELEASE_EVIDENCE_INVALID: ${message}`)
  process.exit(1)
}

function scan(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => scan(item, `${path}[${index}]`))
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value)) fail(`forbidden secret-shaped value at ${path}`)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) fail(`forbidden secret-shaped field at ${path}.${key}`)
    scan(child, `${path}.${key}`)
  }
}

function validDigest(value, pattern) {
  return typeof value === 'string' && pattern.test(value) && !HOMOGENEOUS_HEX.test(value)
}

function uniqueStrings(value) {
  return Array.isArray(value) && new Set(value).size === value.length && value.every((item) => typeof item === 'string')
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
if (!validDigest(value.candidateSha, SHA)) fail('candidateSha must be a non-placeholder lowercase 40-character Git SHA')
if (!validDigest(value.previousReleaseSha, SHA)) fail('previousReleaseSha must be a non-placeholder lowercase 40-character Git SHA')
if (value.candidateSha === value.previousReleaseSha) fail('candidateSha must differ from previousReleaseSha')
if (!value.environment?.id || !value.environment?.name) fail('environment id and name are required')
if (value.ci?.headSha !== value.candidateSha || value.ci?.status !== 'success' || !value.ci?.runUrl) {
  fail('exact-head successful CI evidence is required')
}
if (!validDigest(value.artifact?.sha256, SHA256)) fail('artifact sha256 must be a non-placeholder lowercase 64-character digest')
if (value.manifest?.gitSha !== value.candidateSha) fail('manifest must bind the candidate SHA')
if (value.health?.staging !== 'ok' || value.health?.production !== 'unchanged-ok') {
  fail('staging and unchanged production health are required')
}
if (value.migrations?.status === 'verified') {
  if (!uniqueStrings(value.migrations.versions) || value.migrations.versions.length === 0) {
    fail('verified migrations require a non-empty unique versions list')
  }
  if (!value.migrations.versions.every((version) => MIGRATION_VERSION.test(version))) {
    fail('migration versions must be exact 14-digit Supabase versions')
  }
} else if (value.migrations?.status === 'not-required') {
  if (!Array.isArray(value.migrations.versions) || value.migrations.versions.length !== 0) {
    fail('not-required migrations must have an empty versions list')
  }
} else {
  fail('migration status must be verified or not-required')
}
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
