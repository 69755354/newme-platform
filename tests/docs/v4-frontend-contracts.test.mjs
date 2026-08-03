import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadDocuments, validateDocuments, validateV4FrontendContracts } from '../../scripts/check-v4-frontend-contracts.mjs'

const clone = (value) => structuredClone(value)

test('V4 frontend registry, schemas, routes and trace close on repository state', () => {
  const result = validateV4FrontendContracts()
  assert.deepEqual(result, { requirements: 41, frontend_requirements: 25, acceptance: 47, screens: 24, routes: 27, event_keys: 95, payload_contracts: 95, sources: 22, source_evidence: 22, schemas: 9, error_experiences: 13, role_mappings: 6 })
})

test('V4 frontend trace fails when canonical meaning drifts', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.trace.frontend_requirements[0].source_refs[0].meaning = 'drift'
  assert.throws(() => validateDocuments(mutated), /source or meaning drift/)
})

test('V4 frontend acceptance fails when a closure link is missing', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.trace.acceptance[46].release_gates = []
  assert.throws(() => validateDocuments(mutated), /closure fields must be non-empty/)
})

test('V4 frontend API fails when client can provide canonical idempotency key', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.api.idempotency_key.client_may_supply = true
  assert.throws(() => validateDocuments(mutated), /server canonical/)
})

test('V4 frontend event model fails on abbreviated event keys', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.eventModel += '\n`...completed.v1`\n'
  assert.throws(() => validateDocuments(mutated), /abbreviated event key/)
})

test('V4 frontend provenance fails when the upstream Git blob drifts', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.ids.canonical_source.blob = '0000000000000000000000000000000000000000'
  mutated.trace.upstream_registry.blob = mutated.ids.canonical_source.blob
  assert.throws(() => validateDocuments(mutated), /upstream V4 trace blob/)
})

test('V4 frontend payload registry fails when an event loses its strict command schema', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.payloads.entries[0].command_payload_schema.additionalProperties = true
  assert.throws(() => validateDocuments(mutated), /must be strict and discriminated/)
})

test('V4 frontend error experience fails when localized recovery copy is incomplete', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  delete mutated.api.error_experience[0].localized_copy.ar
  assert.throws(() => validateDocuments(mutated), /localized copy incomplete/)
})

test('V4 conflict registry fails when canonical line or resolution drifts', () => {
  for (const field of ['canonical_line','resolution']) {
    const docs = loadDocuments()
    const mutated = clone(docs)
    mutated.ids.provenance_conflicts[0][field] = field === 'canonical_line' ? 1 : 'ignore the authoritative table'
    assert.throws(() => validateDocuments(mutated), /canonical conflict line drift|conflict resolution drift/)
  }
})

test('V4 platform policy fails when ops can close or support can approve', () => {
  const docs = loadDocuments()
  const closeMutation = clone(docs)
  closeMutation.api.endpoints.find((item) => item.path.endsWith('/organizations/{organization_id}/transitions')).transition_policy.platform_ops.push('closed')
  assert.throws(() => validateDocuments(closeMutation), /must not close organizations/)
  const approvalMutation = clone(docs)
  approvalMutation.api.endpoints.find((item) => item.path.endsWith('/support-session-requests/{support_session_request_id}/approve')).roles.push('platform_support')
  assert.throws(() => validateDocuments(approvalMutation), /approval must be independent/)
})

test('V4 purchase request rejects loose line items', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.payloads.entries.find((item) => item.command === 'create_purchase_request').command_payload_schema.properties.lines.items.additionalProperties = true
  assert.throws(() => validateDocuments(mutated), /purchase request currency\/strict line contract missing/)
})

test('V4 immutable OFF registry metadata rejects hash drift without claiming webpage content', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.sourceEvidence.records[0].record_sha256 = '0'.repeat(64)
  assert.throws(() => validateDocuments(mutated), /evidence hash mismatch/)
})

test('V4 event source command semantics cannot be removed', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  delete mutated.schemas.find(([name]) => name === 'event.schema.v1.json')[1]['x-source-command-constraint']
  assert.throws(() => validateDocuments(mutated), /source.command semantic constraint missing/)
})

test('V4 command result status semantics cannot be removed', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.schemas.find(([name]) => name === 'command-result.schema.v1.json')[1].allOf = []
  assert.throws(() => validateDocuments(mutated), /command result status semantics missing/)
})

test('V4 work-item dispositions require all five strict commands', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.api.endpoints.find((item) => item.path.endsWith('/work-items/{work_item_id}/dispositions')).allowed_commands.pop()
  assert.throws(() => validateDocuments(mutated), /work-item disposition command coverage drift/)
})

test('V4 SAM-18 and SAM-19 role mapping rejects canonical drift', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.roleMapping.legacy_to_canonical.find((item) => item.legacy_role === 'boss').canonical_role = 'platform_owner'
  assert.throws(() => validateDocuments(mutated), /legacy role mapping drift/)
})

test('V4 frontend provenance requires the CI checkout to retain full history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newme-v4-workflow-'))
  try {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - name: Checkout\n    uses: actions/checkout@v4\n')
    assert.throws(() => validateDocuments(loadDocuments(), root), /requires full-history checkout/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('V4 lifecycle transitions cannot bypass independent approved facts', () => {
  const docs = loadDocuments()
  for (const command of ['transition_organization_lifecycle','transition_billing_lifecycle']) {
    const mutated = clone(docs)
    const schema = mutated.payloads.entries.find((item) => item.command === command).command_payload_schema
    schema.required = schema.required.filter((field) => field !== 'approval_event_id')
    assert.throws(() => validateDocuments(mutated), /lifecycle payload approval facts incomplete/)
  }
  const ownerBypass = clone(docs)
  ownerBypass.api.endpoints.find((item) => item.command === 'transition_organization_lifecycle').approval_required = false
  assert.throws(() => validateDocuments(ownerBypass), /lifecycle must require independent approved transition/)
})

test('V4 platform support can revoke only own requested active session', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.api.endpoints.find((item) => item.command === 'revoke_support_session').authorization_policy.platform_support = 'any_active_session'
  assert.throws(() => validateDocuments(mutated), /restricted to own requested active session/)
})

test('V4 retail receipt inventory and finance facts are strict for AC-29 through AC-32', () => {
  const docs = loadDocuments()
  const receipt = clone(docs)
  delete receipt.payloads.entries.find((item) => item.command === 'post_purchase_receipt').command_payload_schema.properties.lines.items['x-receipt-line-constraint']
  assert.throws(() => validateDocuments(receipt), /AC-30 receipt line strict variance contract missing/)
  const movement = clone(docs)
  movement.payloads.entries.find((item) => item.command === 'record_inventory_movement').command_payload_schema.properties.quantity.exclusiveMinimum = -1
  assert.throws(() => validateDocuments(movement), /AC-29 inventory movement facts incomplete/)
  const finance = clone(docs)
  finance.payloads.entries.find((item) => item.command === 'confirm_retail_finance').event_payload_schema.required = ['finance_case_id','confirmed_by_actor_id','confirmed_at']
  assert.throws(() => validateDocuments(finance), /AC-31 finance confirmation facts incomplete/)
})

test('V4 OFF registry snapshot cannot claim immutable webpage content', () => {
  const docs = loadDocuments()
  const mutated = clone(docs)
  mutated.sourceEvidence.snapshot_scope = 'immutable webpage body snapshot'
  assert.throws(() => validateDocuments(mutated), /snapshot scope overclaims webpage content/)
})

test('V4 command result requires error class and exact request id binding', () => {
  const docs = loadDocuments()
  const missingBinding = clone(docs)
  delete missingBinding.schemas.find(([name]) => name === 'command-result.schema.v1.json')[1]['x-error-request-id-match']
  assert.throws(() => validateDocuments(missingBinding), /request_id binding missing/)
  const missingClasses = clone(docs)
  missingClasses.schemas.find(([name]) => name === 'command-result.schema.v1.json')[1].allOf.pop()
  assert.throws(() => validateDocuments(missingClasses), /failed result accepted denial-class error|failed result error rule failed/)
})
