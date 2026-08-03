import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  loadDocuments,
  stagingArchiveProvenanceContent,
  stagingArchiveProvenancePath,
  validateDocuments,
  validateStagingArchiveProvenance,
  validateV4FrontendContracts,
} from '../../scripts/check-v4-frontend-contracts.mjs'

const clone = (value) => structuredClone(value)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function createArchiveFixture() {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repositoryRoot, stdio: 'ignore' })
  } catch {
    const upstream = loadDocuments(repositoryRoot).ids.canonical_source
    const metadata = fs.lstatSync(stagingArchiveProvenancePath)
    return {
      directory: null,
      root: repositoryRoot,
      upstream,
      env: process.env,
      metadata,
      nested: false,
    }
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newme-v4-archive-'))
  const root = path.join(directory, 'source')
  const archive = path.join(directory, 'source.tar')
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  fs.mkdirSync(root)
  execFileSync('git', ['archive', '--format=tar', '-o', archive, candidateSha], { cwd: repositoryRoot })
  execFileSync('tar', ['-xf', archive, '-C', root])
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', '--force', '--all'], { cwd: root })
  const treeSha = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()
  const upstream = loadDocuments(root).ids.canonical_source
  const content = stagingArchiveProvenanceContent({
    candidateSha,
    upstreamSha: upstream.commit,
    upstreamBlob: upstream.blob,
    treeSha,
  })
  const env = {
    ...process.env,
    CI: 'true',
    NEXT_PUBLIC_APP_VERSION: candidateSha,
    NEWME_STAGING_EXPECTED_SHA: candidateSha,
    NEWME_STAGING_UPSTREAM_SHA: upstream.commit,
    NEWME_STAGING_UPSTREAM_BLOB: upstream.blob,
    NEWME_STAGING_EXPECTED_TREE: treeSha,
    NEWME_STAGING_ARCHIVE_PROVENANCE_PATH: stagingArchiveProvenancePath,
    NEWME_STAGING_ARCHIVE_PROVENANCE_SHA256: createHash('sha256').update(content).digest('hex'),
  }
  const metadata = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    gid: 0,
    mode: 0o100400,
    nlink: 1,
    size: Buffer.byteLength(content),
  }
  return { directory, root, upstream, env, metadata, nested: true }
}

const cleanupArchiveFixture = (fixture) => {
  if (fixture.directory) fs.rmSync(fixture.directory, { recursive: true, force: true })
}

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

test('V4 staging archive provenance reaches the real contracts without weakening ordinary checkout ancestry', () => {
  const fixture = createArchiveFixture()
  const provenanceDependencies = {
    env: fixture.env,
    lstatSync: () => fixture.metadata,
  }
  try {
    assert.doesNotThrow(() => validateDocuments(loadDocuments(fixture.root), fixture.root, { provenanceDependencies }))
    const mutated = clone(loadDocuments(fixture.root))
    mutated.trace.frontend_requirements[0].source_refs[0].meaning = 'drift'
    assert.throws(
      () => validateDocuments(mutated, fixture.root, { provenanceDependencies }),
      /source or meaning drift/,
    )

    if (fixture.nested) {
      const forgedNormalEnvironment = {
        ...process.env,
        NEWME_STAGING_EXPECTED_SHA: fixture.env.NEWME_STAGING_EXPECTED_SHA,
      }
      assert.throws(
        () => validateDocuments(loadDocuments(), repositoryRoot, {
          provenanceDependencies: { env: forgedNormalEnvironment },
        }),
        /staging archive provenance is forbidden in a normal checkout/,
      )
    }
  } finally {
    cleanupArchiveFixture(fixture)
  }
})

test('V4 staging archive provenance rejects missing, drifted, and forged root evidence', async (t) => {
  const fixture = createArchiveFixture()
  const validate = (env = fixture.env, metadata = fixture.metadata) =>
    validateStagingArchiveProvenance(fixture.root, fixture.upstream, {
      env,
      lstatSync: () => metadata,
    })
  try {
    assert.doesNotThrow(() => validate())
    await t.test('missing CI marker', () => {
      assert.throws(() => validate({ ...fixture.env, CI: '' }), /requires CI=true/)
    })
    await t.test('candidate SHA drift', () => {
      assert.throws(
        () => validate({ ...fixture.env, NEXT_PUBLIC_APP_VERSION: '0'.repeat(40) }),
        /candidate SHA and application version differ/,
      )
    })
    await t.test('upstream SHA drift', () => {
      assert.throws(
        () => validate({ ...fixture.env, NEWME_STAGING_UPSTREAM_SHA: '0'.repeat(40) }),
        /upstream SHA drift/,
      )
    })
    await t.test('tree drift', () => {
      assert.throws(
        () => validate({ ...fixture.env, NEWME_STAGING_EXPECTED_TREE: '0'.repeat(40) }),
        /provenance digest drift|index tree differs/,
      )
    })
    await t.test('forged digest', () => {
      assert.throws(
        () => validate({ ...fixture.env, NEWME_STAGING_ARCHIVE_PROVENANCE_SHA256: '0'.repeat(64) }),
        /provenance digest drift/,
      )
    })
    await t.test('non-root or writable marker', () => {
      assert.throws(
        () => validate(fixture.env, { ...fixture.metadata, uid: 1000, mode: 0o100600 }),
        /ownership or mode drift/,
      )
    })
    await t.test('symlink marker', () => {
      assert.throws(
        () => validate(fixture.env, { ...fixture.metadata, isFile: () => false, isSymbolicLink: () => true }),
        /regular non-symlink/,
      )
    })
  } finally {
    cleanupArchiveFixture(fixture)
  }
})

test('staging build creates and forwards only fixed root-owned archive provenance', () => {
  const runner = fs.readFileSync(path.join(repositoryRoot, 'scripts/run-staging-build.sh'), 'utf8')
  const builder = fs.readFileSync(path.join(repositoryRoot, 'scripts/build-staging-artifact.sh'), 'utf8')
  for (const token of [
    'PROVENANCE="/run/newme-staging-build.provenance"',
    'merge-base --is-ancestor "$UPSTREAM_SHA" "$SHA"',
    'rev-parse "$SHA^{tree}"',
    '[ "$ARCHIVE_TREE" = "$EXPECTED_TREE" ]',
    'chown root:root "$PROVENANCE_TEMP"',
    'chmod 0400 "$PROVENANCE_TEMP"',
    'CI=true',
    'NEWME_STAGING_EXPECTED_SHA="$SHA"',
    'NEWME_STAGING_UPSTREAM_SHA="$UPSTREAM_SHA"',
    'NEWME_STAGING_EXPECTED_TREE="$EXPECTED_TREE"',
    'NEWME_STAGING_ARCHIVE_PROVENANCE_PATH="$PROVENANCE"',
  ]) assert.ok(runner.includes(token), `missing root staging provenance contract: ${token}`)
  assert.ok(runner.indexOf('merge-base --is-ancestor') < runner.indexOf('setsid runuser'))
  assert.ok(runner.indexOf('chmod 0400 "$PROVENANCE_TEMP"') < runner.indexOf('setsid runuser'))
  for (const token of [
    'readonly STAGING_ARCHIVE_PROVENANCE="/run/newme-staging-build.provenance"',
    '[ "$PROVENANCE_PATH" = "$STAGING_ARCHIVE_PROVENANCE" ]',
    '[ "${CI:-}" = "true" ]',
    '[ "${NEWME_STAGING_EXPECTED_SHA:-}" = "$SHA" ]',
    '[ "$(stat -c \'%u:%g:%a\' "$PROVENANCE_PATH")" = "0:0:400" ]',
  ]) assert.ok(builder.includes(token), `missing child staging provenance contract: ${token}`)
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
