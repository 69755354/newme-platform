#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = process.env.V4_GOVERNANCE_ROOT ? resolve(process.env.V4_GOVERNANCE_ROOT) : resolve(skillRoot, '..', '..')

const required = [
  'docs/v4/V4_SAAS_PRD.md',
  'docs/v4/V4_DELIVERY_OPERATIONS_PLAN.md',
  'docs/v4/V4_REQUIREMENTS_TRACEABILITY.md',
  'docs/v4/V4_EXECUTION_BACKLOG.md',
  'docs/v4/V4_EXTERNAL_AUDIT_INDEX.md',
  'skills/newme-v4-delivery/SKILL.md',
  'skills/newme-v4-delivery/agents/openai.yaml',
  'skills/newme-v4-delivery/references/work-package-and-traceability.md',
  'skills/newme-v4-delivery/references/tenant-data-and-migrations.md',
  'skills/newme-v4-delivery/references/git-ci-and-evidence.md',
  'skills/newme-v4-delivery/references/staging-release-and-operations.md',
  'skills/newme-v4-delivery/references/vertical-acceptance.md',
  'skills/newme-v4-delivery/assets/work-package.template.json',
  'skills/newme-v4-delivery/assets/pr-body.template.md',
  'skills/newme-v4-delivery/assets/linear-evidence-comment.template.md',
  'skills/newme-v4-delivery/assets/release-evidence.template.json',
  'skills/newme-v4-delivery/scripts/validate-governance.mjs',
  'skills/newme-v4-delivery/scripts/validate-work-package.mjs',
  'skills/newme-v4-delivery/scripts/validate-release-evidence.mjs',
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
const gateSection = prd.match(/^## 15\. Commercial release gates\s*$([\s\S]*?)(?=^##\s)/m)?.[1] ?? ''
const gates = [...gateSection.matchAll(/^- \*\*G([0-8]) [^*]+:\*\* \S.*$/gm)].map((match) => Number(match[1]))
if (gates.join(',') !== '0,1,2,3,4,5,6,7,8') fail('PRD must define exactly ordered structured gates G0..G8 in section 15')

const backlog = await text('docs/v4/V4_EXECUTION_BACKLOG.md')
const audit = await text('docs/v4/V4_EXTERNAL_AUDIT_INDEX.md')
const backlogSection = backlog.match(/^## 3\.[^\n]*$([\s\S]*?)(?=^##\s)/m)?.[1] ?? ''
const auditSection = audit.match(/^## 3\.[^\n]*$([\s\S]*?)(?=^##\s)/m)?.[1] ?? ''
const backlogIssues = [...backlogSection.matchAll(/^\| P\d+ \| \[SAM-(\d+)\]\(/gm)].map((match) => Number(match[1]))
const auditIssues = [...auditSection.matchAll(/^\| \[SAM-(\d+)\]\(/gm)].map((match) => Number(match[1]))
const expectedIssues = Array.from({ length: 12 }, (_, index) => index + 77).join(',')
if (backlogIssues.join(',') !== expectedIssues) fail('execution backlog must contain exactly one ordered table row for SAM-77..SAM-88')
if (auditIssues.join(',') !== expectedIssues) fail('audit index must contain exactly one ordered table row for SAM-77..SAM-88')

const skill = await text('skills/newme-v4-delivery/SKILL.md')
for (const marker of ['validate-governance.mjs', 'validate-work-package.mjs', 'validate-release-evidence.mjs']) {
  if (!skill.includes(marker)) fail(`SKILL.md is missing ${marker}`)
}
if (!skill.includes('agents/openai.yaml')) fail('SKILL.md must document the Codex interface metadata')

const agentMetadata = await text('skills/newme-v4-delivery/agents/openai.yaml')
for (const marker of ['interface:', 'display_name:', 'short_description:', 'default_prompt:']) {
  if (!agentMetadata.includes(marker)) fail(`agents/openai.yaml is missing ${marker}`)
}

JSON.parse(await text('skills/newme-v4-delivery/assets/work-package.template.json'))
JSON.parse(await text('skills/newme-v4-delivery/assets/release-evidence.template.json'))

console.log(`V4 governance valid: ${required.length} required artifacts, SAM-77..SAM-88, G0..G8`)
