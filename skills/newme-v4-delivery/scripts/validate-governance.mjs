#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(skillRoot, '..', '..')

const required = [
  'docs/v4/V4_SAAS_PRD.md',
  'docs/v4/V4_DELIVERY_OPERATIONS_PLAN.md',
  'docs/v4/V4_REQUIREMENTS_TRACEABILITY.md',
  'docs/v4/V4_EXECUTION_BACKLOG.md',
  'docs/v4/V4_EXTERNAL_AUDIT_INDEX.md',
  'skills/newme-v4-delivery/SKILL.md',
  'skills/newme-v4-delivery/references/work-package-and-traceability.md',
  'skills/newme-v4-delivery/references/tenant-data-and-migrations.md',
  'skills/newme-v4-delivery/references/git-ci-and-evidence.md',
  'skills/newme-v4-delivery/references/staging-release-and-operations.md',
  'skills/newme-v4-delivery/references/vertical-acceptance.md',
  'skills/newme-v4-delivery/assets/work-package.template.json',
  'skills/newme-v4-delivery/assets/pr-body.template.md',
  'skills/newme-v4-delivery/assets/linear-evidence-comment.template.md',
  'skills/newme-v4-delivery/assets/release-evidence.template.json',
  'skills/newme-v4-delivery/scripts/validate-scripts.test.mjs'
]

function fail(message) {
  console.error(`V4_GOVERNANCE_INVALID: ${message}`)
  process.exit(1)
}

async function text(relative) {
  try {
    return await readFile(resolve(repoRoot, relative), 'utf8')
  } catch (error) {
    fail(`missing or unreadable ${relative}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

for (const path of required) await text(path)

const prd = await text('docs/v4/V4_SAAS_PRD.md')
for (let gate = 0; gate <= 8; gate += 1) {
  if (!prd.includes(`G${gate}`)) fail(`PRD is missing G${gate}`)
}

const backlog = await text('docs/v4/V4_EXECUTION_BACKLOG.md')
const audit = await text('docs/v4/V4_EXTERNAL_AUDIT_INDEX.md')
for (let issue = 77; issue <= 88; issue += 1) {
  if (!backlog.includes(`SAM-${issue}`)) fail(`execution backlog is missing SAM-${issue}`)
  if (!audit.includes(`SAM-${issue}`)) fail(`audit index is missing SAM-${issue}`)
}

const skill = await text('skills/newme-v4-delivery/SKILL.md')
for (const marker of ['validate-governance.mjs', 'validate-work-package.mjs', 'validate-release-evidence.mjs']) {
  if (!skill.includes(marker)) fail(`SKILL.md is missing ${marker}`)
}

JSON.parse(await text('skills/newme-v4-delivery/assets/work-package.template.json'))
JSON.parse(await text('skills/newme-v4-delivery/assets/release-evidence.template.json'))

console.log(`V4 governance valid: ${required.length} required artifacts, SAM-77..SAM-88, G0..G8`)
