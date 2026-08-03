import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const defaultRoot = path.resolve(scriptDir, '..')
const contractDir = 'docs/v4-frontend-increment/contracts'
export const stagingArchiveProvenancePath = '/run/newme-staging-build.provenance'

const readJson = (root, name) => JSON.parse(fs.readFileSync(path.join(root, contractDir, name), 'utf8'))
const invariant = (condition, message) => {
  if (!condition) throw new Error(`v4_frontend_contract_failed: ${message}`)
}

export const stagingArchiveProvenanceContent = ({ candidateSha, upstreamSha, upstreamBlob, treeSha }) =>
  `candidate_sha=${candidateSha}\nupstream_sha=${upstreamSha}\nupstream_blob=${upstreamBlob}\ntree_sha=${treeSha}\n`

export function validateStagingArchiveProvenance(root, upstream, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const run = dependencies.execFileSync ?? execFileSync
  const lstat = dependencies.lstatSync ?? fs.lstatSync
  const candidateSha = env.NEWME_STAGING_EXPECTED_SHA ?? ''
  const upstreamSha = env.NEWME_STAGING_UPSTREAM_SHA ?? ''
  const upstreamBlob = env.NEWME_STAGING_UPSTREAM_BLOB ?? ''
  const treeSha = env.NEWME_STAGING_EXPECTED_TREE ?? ''

  invariant(env.CI === 'true', 'staging archive provenance requires CI=true')
  invariant(env.NEWME_STAGING_ARCHIVE_PROVENANCE_PATH === stagingArchiveProvenancePath, 'staging archive provenance path drift')
  invariant(/^[0-9a-f]{40}$/.test(candidateSha), 'staging archive candidate SHA is malformed')
  invariant(env.NEXT_PUBLIC_APP_VERSION === candidateSha, 'staging archive candidate SHA and application version differ')
  invariant(upstreamSha === upstream.commit, 'staging archive upstream SHA drift')
  invariant(upstreamBlob === upstream.blob, 'staging archive upstream blob drift')
  invariant(/^[0-9a-f]{40}$/.test(treeSha), 'staging archive candidate tree is malformed')

  let provenance
  try { provenance = lstat(stagingArchiveProvenancePath) } catch { provenance = null }
  invariant(provenance?.isFile() && !provenance.isSymbolicLink?.(), 'staging archive provenance must be a regular non-symlink file')
  invariant(provenance.uid === 0 && provenance.gid === 0 && (provenance.mode & 0o777) === 0o400 && provenance.nlink === 1, 'staging archive provenance ownership or mode drift')

  const content = stagingArchiveProvenanceContent({ candidateSha, upstreamSha, upstreamBlob, treeSha })
  const digest = createHash('sha256').update(content).digest('hex')
  invariant(env.NEWME_STAGING_ARCHIVE_PROVENANCE_SHA256 === digest, 'staging archive provenance digest drift')
  invariant(provenance.size === Buffer.byteLength(content), 'staging archive provenance size drift')

  const indexTree = run('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim()
  invariant(indexTree === treeSha, 'staging archive index tree differs from the candidate tree')
  try {
    run('git', ['diff-files', '--quiet'], { cwd: root, stdio: 'ignore' })
  } catch {
    invariant(false, 'staging archive working tree differs from its verified index')
  }
  return { candidateSha, upstreamSha, upstreamBlob, treeSha }
}

function createGitProvenance(root, upstream, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const run = dependencies.execFileSync ?? execFileSync
  let upstreamIsAncestor = true
  try { run('git', ['merge-base', '--is-ancestor', upstream.commit, 'HEAD'], { cwd: root, stdio: 'ignore' }) } catch { upstreamIsAncestor = false }

  if (upstreamIsAncestor) {
    for (const key of [
      'NEWME_STAGING_EXPECTED_SHA',
      'NEWME_STAGING_UPSTREAM_SHA',
      'NEWME_STAGING_UPSTREAM_BLOB',
      'NEWME_STAGING_EXPECTED_TREE',
      'NEWME_STAGING_ARCHIVE_PROVENANCE_PATH',
      'NEWME_STAGING_ARCHIVE_PROVENANCE_SHA256'
    ]) invariant(!env[key], 'staging archive provenance is forbidden in a normal checkout')
    return {
      mode: 'history',
      sourceBlob: (commit, filePath) => run('git', ['rev-parse', `${commit}:${filePath}`], { cwd: root, encoding: 'utf8' }).trim(),
      candidateBlob: (filePath) => run('git', ['rev-parse', `HEAD:${filePath}`], { cwd: root, encoding: 'utf8' }).trim(),
      sourceText: (commit, filePath) => run('git', ['show', `${commit}:${filePath}`], { cwd: root, encoding: 'utf8' }),
      isTracked: (filePath) => run('git', ['ls-files', '--error-unmatch', filePath], { cwd: root, encoding: 'utf8' }).trim().length > 0
    }
  }

  let hasHead = true
  try { run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'ignore' }) } catch { hasHead = false }
  invariant(!hasHead, 'upstream V4 source must be an ancestor of the candidate commit')
  validateStagingArchiveProvenance(root, upstream, dependencies)
  const indexBlob = (filePath) => run('git', ['rev-parse', `:${filePath}`], { cwd: root, encoding: 'utf8' }).trim()
  return {
    mode: 'staging-archive',
    sourceBlob: (commit, filePath) => {
      invariant(commit === upstream.commit, 'staging archive source commit differs from the verified upstream')
      return indexBlob(filePath)
    },
    candidateBlob: indexBlob,
    sourceText: (commit, filePath) => {
      invariant(commit === upstream.commit, 'staging archive source commit differs from the verified upstream')
      return fs.readFileSync(path.join(root, filePath), 'utf8')
    },
    isTracked: (filePath) => run('git', ['ls-files', '--error-unmatch', filePath], { cwd: root, encoding: 'utf8' }).trim().length > 0
  }
}

const valueAt = (value, dottedPath) => dottedPath.split('.').reduce((current, key) => current?.[key], value)
const jsonTypeMatches = (value, type) => type === 'null' ? value === null
  : type === 'array' ? Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : typeof value === type

export function compileJsonSchema(schema, context = {}) {
  const compile = (node, location = '$') => {
    if (node.$ref) {
      const target = context.schemas?.get(node.$ref)
      invariant(target, `${location} unresolved schema ref ${node.$ref}`)
      return compile(target, `${location}->$ref(${node.$ref})`)
    }
    const branches = node.oneOf?.map((branch, index) => compile(branch, `${location}.oneOf[${index}]`)) ?? []
    const allOf = node.allOf?.map((branch, index) => compile(branch, `${location}.allOf[${index}]`)) ?? []
    const ifValidator = node.if ? compile(node.if, `${location}.if`) : null
    const thenValidator = node.then ? compile(node.then, `${location}.then`) : null
    const elseValidator = node.else ? compile(node.else, `${location}.else`) : null
    const propertyValidators = new Map(Object.entries(node.properties ?? {}).map(([key, child]) => [key, compile(child, `${location}.${key}`)]))
    const itemValidator = node.items ? compile(node.items, `${location}[]`) : null
    const pattern = node.pattern ? new RegExp(node.pattern) : null
    return (value) => {
      const errors = []
      if (node.type) {
        const accepted = Array.isArray(node.type) ? node.type : [node.type]
        if (!accepted.some((type) => jsonTypeMatches(value, type))) errors.push(`${location} type`)
      }
      if (node.const !== undefined && value !== node.const) errors.push(`${location} const`)
      if (node.enum && !node.enum.some((entry) => Object.is(entry, value))) errors.push(`${location} enum`)
      if (typeof value === 'string') {
        if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${location} minLength`)
        if (node.maxLength !== undefined && value.length > node.maxLength) errors.push(`${location} maxLength`)
        if (pattern && !pattern.test(value)) errors.push(`${location} pattern`)
        if (node.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) errors.push(`${location} uuid`)
        if (node.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${location} date-time`)
      }
      if (typeof value === 'number') {
        if (node.minimum !== undefined && value < node.minimum) errors.push(`${location} minimum`)
        if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) errors.push(`${location} exclusiveMinimum`)
      }
      if (Array.isArray(value)) {
        if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${location} minItems`)
        if (node.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${location} uniqueItems`)
        if (itemValidator) value.forEach((item) => errors.push(...itemValidator(item)))
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const required of node.required ?? []) if (!(required in value)) errors.push(`${location}.${required} required`)
        if (node.additionalProperties === false) for (const key of Object.keys(value)) if (!propertyValidators.has(key)) errors.push(`${location}.${key} additional`)
        for (const [key, validator] of propertyValidators) if (key in value) errors.push(...validator(value[key]))
      }
      if (branches.length) {
        const passes = branches.filter((validator) => validator(value).length === 0).length
        if (passes !== 1) errors.push(`${location} oneOf`)
      }
      for (const validator of allOf) errors.push(...validator(value))
      if (ifValidator) {
        const matched = ifValidator(value).length === 0
        if (matched && thenValidator) errors.push(...thenValidator(value))
        if (!matched && elseValidator) errors.push(...elseValidator(value))
      }
      if (node['x-discriminator']) {
        const spec = node['x-discriminator']
        const entry = context.payloads?.entries.find((item) => item[spec.property] === value?.[spec.property])
        if (!entry) errors.push(`${location} discriminator`)
        else errors.push(...compile(entry[spec.schema_property], `${location}.${spec.payload_property}<${entry[spec.property]}>`)(value?.[spec.payload_property]))
      }
      if (node['x-command-event-constraint']) {
        const spec = node['x-command-event-constraint']
        const command = valueAt(value, spec.command_path)
        const expectedEvent = valueAt(value, spec.event_path)
        const entry = context.payloads?.entries.find((item) => item.command === command)
        if (!entry || entry.event_type !== expectedEvent) errors.push(`${location} command-event constraint`)
      }
      if (node['x-source-command-constraint']) {
        const spec = node['x-source-command-constraint']
        const eventType = valueAt(value, spec.event_path)
        const sourceCommand = valueAt(value, spec.command_path)
        const entry = context.payloads?.entries.find((item) => item.event_type === eventType)
        if (!entry || entry.command !== sourceCommand) errors.push(`${location} source-command constraint`)
      }
      if (node['x-distinct']) {
        const values = node['x-distinct'].map((key) => value?.[key])
        if (new Set(values).size !== values.length) errors.push(`${location} distinct fields`)
      }
      if (node['x-error-request-id-match'] && value?.error !== null && value?.error?.request_id !== value?.request_id) errors.push(`${location} error request_id mismatch`)
      if (node['x-receipt-line-constraint']) {
        if (value?.variance !== value?.received_qty - value?.expected_qty) errors.push(`${location} receipt variance`)
        const expectedDisposition = value?.received_qty > value?.expected_qty ? 'approved_exception' : 'not_applicable'
        if (value?.over_receipt_disposition !== expectedDisposition) errors.push(`${location} over-receipt disposition`)
      }
      return errors
    }
  }
  return compile(schema)
}

const exampleFor = (schema, context) => {
  if (schema.$ref) return exampleFor(context.schemas.get(schema.$ref), context)
  if (schema.oneOf && !schema.type) return exampleFor(schema.oneOf[0], context)
  if (schema.const !== undefined) return schema.const
  if (schema.enum) return schema.enum[0]
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== 'null') ?? 'null' : schema.type
  if (type === 'null') return null
  if (type === 'object') {
    const value = Object.fromEntries((schema.required ?? []).map((key) => [key, exampleFor(schema.properties[key], context)]))
    if (schema.oneOf) Object.assign(value, exampleFor(schema.oneOf[0], context))
    if (schema['x-receipt-line-constraint']) {
      value.variance = value.received_qty - value.expected_qty
      value.over_receipt_disposition = value.received_qty > value.expected_qty ? 'approved_exception' : 'not_applicable'
    }
    return value
  }
  if (type === 'array') return Array.from({ length: Math.max(1, schema.minItems ?? 0) }, () => exampleFor(schema.items, context))
  if (type === 'integer') return Math.max(1, schema.minimum ?? 1)
  if (type === 'number') return Math.max(1, (schema.exclusiveMinimum ?? schema.minimum ?? 0) + 1)
  if (type === 'boolean') return false
  if (schema.format === 'uuid') return '123e4567-e89b-42d3-a456-426614174000'
  if (schema.format === 'date-time') return '2026-08-03T00:00:00Z'
  if (schema.pattern === '^[A-Z]{3}$') return 'AED'
  if (schema.pattern === '^[A-Z][A-Z0-9_]+$') return 'CODE'
  if (schema.pattern?.startsWith('^(error|status)')) return 'error.test'
  return 'value'.padEnd(schema.minLength ?? 1, 'x')
}

export function loadDocuments(root = defaultRoot) {
  return {
    ids: readJson(root, 'v4-id-registry.v1.json'),
    trace: readJson(root, 'frontend-traceability.v1.json'),
    routes: readJson(root, 'screen-route-registry.v1.json'),
    events: readJson(root, 'event-key-registry.v1.json'),
    payloads: readJson(root, 'event-command-payload-registry.v1.json'),
    api: readJson(root, 'frontend-api-contract.v1.json'),
    sources: readJson(root, 'research-source-registry.v1.json'),
    sourceEvidence: readJson(root, 'research-evidence-snapshot.v1.json'),
    roleMapping: readJson(root, 'legacy-role-mapping.v1.json'),
    schemas: ['event-type.schema.v1.json','event.schema.v1.json','work-item.schema.v1.json','nba.schema.v1.json','command.schema.v1.json','error.schema.v1.json','command-result.schema.v1.json','event-stream-response.schema.v1.json','platform-read-responses.schema.v1.json'].map((name) => [name, readJson(root, name)]),
    eventModel: fs.readFileSync(path.join(root, 'docs/v4-frontend-increment/V4_FRONTEND_EVENT_AND_NBA_MODEL.md'), 'utf8'),
    prd: fs.readFileSync(path.join(root, 'docs/v4-frontend-increment/V4_FRONTEND_INCREMENT_PRD.md'), 'utf8'),
    platform: fs.readFileSync(path.join(root, 'docs/v4-frontend-increment/V4_PLATFORM_OPERATIONS_AND_LIFECYCLE.md'), 'utf8'),
    nfr: fs.readFileSync(path.join(root, 'docs/v4-frontend-increment/V4_FRONTEND_NONFUNCTIONAL_GATES.md'), 'utf8')
  }
}

export function validateDocuments(documents, root = defaultRoot, options = {}) {
  const { ids, trace, routes, events, payloads, api, sources, sourceEvidence, roleMapping, schemas, eventModel, prd, platform, nfr } = documents
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  const checkoutBlock = workflow.match(/- name:\s*Checkout[\s\S]*?(?=\n\s*- name:)/)?.[0] ?? ''
  invariant(/uses:\s*actions\/checkout@v4/.test(checkoutBlock) && /fetch-depth:\s*0(?:\s|$)/.test(checkoutBlock), 'V4 provenance gate requires full-history checkout')
  const idMap = new Map(ids.requirements.map((item) => [item.id, item]))
  invariant(idMap.size === ids.requirements.length, 'duplicate V4 requirement id')
  invariant(ids.requirements.every((item) => item.id && item.meaning && item.source_path && item.source_locator), 'V4 registry row missing id/meaning/source_path/source_locator')
  const upstream = ids.canonical_source
  invariant(trace.upstream_registry.commit === upstream.commit && trace.upstream_registry.path === upstream.path && trace.upstream_registry.blob === upstream.blob, 'frontend trace upstream provenance drift')
  const gitProvenance = createGitProvenance(root, upstream, options.provenanceDependencies)
  const actualBlob = gitProvenance.sourceBlob(upstream.commit, upstream.path)
  invariant(actualBlob === upstream.blob, 'upstream V4 trace blob does not match Git object')
  invariant(gitProvenance.candidateBlob(upstream.path) === upstream.blob, 'candidate must retain tracked upstream V4 trace bytes')
  const upstreamLines = gitProvenance.sourceText(upstream.commit, upstream.path).split(/\r?\n/)
  for (const item of ids.requirements) {
    const rowIndex = upstreamLines.findIndex((line) => line.startsWith(`| ${item.id} |`))
    invariant(rowIndex >= 0, `${item.id} missing from upstream Git object`)
    const cells = upstreamLines[rowIndex].split('|').map((cell) => cell.trim())
    invariant(cells[2] === item.meaning, `${item.id} meaning differs from upstream row ${rowIndex + 1}`)
    invariant(item.source_locator === `row:${item.id}`, `${item.id} source locator drift`)
  }
  invariant(ids.provenance_conflicts.length === 2, 'V4 PRD/trace conflict register must cover RE-006 and RT-005')
  const requiredConflictResolutions = new Map([
    ['V4-RE-006', 'Use traceability meaning; FE command-view work must not cite V4-RE-006.'],
    ['V4-RT-005', 'Use traceability meaning; delivery/COD work must cite V4-RT-008.']
  ])
  for (const conflict of ids.provenance_conflicts) {
    const canonical = idMap.get(conflict.id)
    const canonicalRowIndex = upstreamLines.findIndex((line) => line.startsWith(`| ${conflict.id} |`))
    invariant(canonical && conflict.canonical_meaning === canonical.meaning, `${conflict.id} canonical conflict meaning drift`)
    invariant(conflict.canonical_line === canonicalRowIndex + 1, `${conflict.id} canonical conflict line drift`)
    invariant(conflict.resolution === requiredConflictResolutions.get(conflict.id), `${conflict.id} conflict resolution drift`)
    const source = conflict.conflicting_source
    const blob = gitProvenance.sourceBlob(source.commit, source.path)
    invariant(blob === source.blob, `${conflict.id} conflicting PRD blob drift`)
    invariant(gitProvenance.candidateBlob(source.path) === source.blob, `${conflict.id} candidate PRD bytes drift`)
    const line = gitProvenance.sourceText(source.commit, source.path).split(/\r?\n/)[source.line - 1]
    invariant(line === `### ${conflict.id} ${source.heading}`, `${conflict.id} conflicting PRD row drift`)
  }

  const feIds = trace.frontend_requirements.map((row) => row.fe_id)
  invariant(feIds.length === 25 && new Set(feIds).size === 25, 'frontend trace must contain unique FE-001..FE-025')
  invariant(prd.includes('需求命名空间：`FE-001`–`FE-025`'), 'frontend PRD namespace header must be FE-001..FE-025')
  invariant(feIds.every((id, index) => id === `FE-${String(index + 1).padStart(3, '0')}`), 'frontend requirement sequence drift')
  for (const row of trace.frontend_requirements) {
    invariant(row.source_refs.length > 0 && row.screens.length > 0 && row.work_packages.length > 0, `${row.fe_id} trace is incomplete`)
    for (const ref of row.source_refs) {
      const canonical = idMap.get(ref.id)
      invariant(canonical, `${row.fe_id} references unknown ${ref.id}`)
      invariant(ref.source_path === canonical.source_path && ref.meaning === canonical.meaning, `${row.fe_id}/${ref.id} source or meaning drift`)
    }
  }

  const sourceIds = new Set(sources.sources.map((item) => item.source_id))
  for (const record of [...trace.decision_research_refs, ...trace.fe_research_refs]) {
    invariant(record.research_source_refs.length > 0, `${record.decision_id ?? record.fe_id} research source refs empty`)
    invariant(record.research_source_refs.every((id) => sourceIds.has(id)), `${record.decision_id ?? record.fe_id} references unknown OFF source`)
  }
  invariant(trace.fe_research_refs.every((item) => feIds.includes(item.fe_id)), 'research mapping references unknown FE id')
  for (const required of ['FE-023','FE-024','FE-025']) invariant(trace.acceptance.some((row) => row.fe_ids.includes(required)), `${required} is not bound to acceptance closure`)

  const screenIds = routes.screens.map((item) => item.id)
  invariant(routes.screen_count === 24 && screenIds.length === 24, 'screen count must be exactly 24')
  invariant(screenIds.every((id, index) => id === `S${String(index + 1).padStart(2, '0')}`), 'screen ids must be S01..S24')
  invariant(routes.components.some((item) => item.id === 'C01' && item.legacy_screen_id === 'S25'), 'S25 must be represented only as component C01')
  invariant(!/^\| S25 \|/m.test(prd), 'PRD must not count S25 as a screen')

  invariant(routes.existing_route_count === 27 && routes.existing_routes.length === 27, 'existing route map must contain 27 routes')
  const mappedFiles = routes.existing_routes.map((item) => item.file.replaceAll('/', path.sep)).sort()
  const actualFiles = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name === 'page.tsx') actualFiles.push(path.relative(root, full))
    }
  }
  visit(path.join(root, 'src/app'))
  invariant(JSON.stringify(mappedFiles) === JSON.stringify(actualFiles.sort()), '27-route mapping does not exactly match src/app page.tsx files')
  invariant(routes.existing_routes.every((item) => item.screen ? screenIds.includes(item.screen) : item.component === 'C01'), 'route references unknown screen/component')

  const workPackages = new Set(Array.from({ length: 9 }, (_, index) => `FE-WP-${String(index).padStart(2, '0')}`))
  const gates = new Set(Array.from({ length: 9 }, (_, index) => `G${index}`))
  const acRows = trace.acceptance
  invariant(acRows.length === 47, 'acceptance trace must contain 47 rows')
  acRows.forEach((row, index) => {
    invariant(row.ac_id === `AC-${String(index + 1).padStart(2, '0')}`, `acceptance sequence drift at ${row.ac_id}`)
    invariant(row.fe_ids.length && row.screens.length && row.work_packages.length && row.release_gates.length, `${row.ac_id} closure fields must be non-empty`)
    invariant(row.fe_ids.every((id) => feIds.includes(id)), `${row.ac_id} references unknown FE id`)
    invariant(row.screens.every((id) => screenIds.includes(id)), `${row.ac_id} references unknown screen`)
    invariant(row.work_packages.every((id) => workPackages.has(id)), `${row.ac_id} references unknown work package`)
    invariant(row.release_gates.every((id) => gates.has(id)), `${row.ac_id} references unknown release gate`)
  })

  const schemaMap = new Map(schemas)
  const schemaContext = { schemas: schemaMap, payloads }
  for (const [name, schema] of schemas) {
    invariant(schema.$schema === 'https://json-schema.org/draft/2020-12/schema', `${name} must use JSON Schema 2020-12`)
    invariant(schema.$id, `${name} must be versioned`)
    if (name === 'event-type.schema.v1.json') invariant(schema.type === 'string' && JSON.stringify(schema.enum) === JSON.stringify(events.event_keys), 'event type enum must exactly match registry')
    else if (name === 'platform-read-responses.schema.v1.json') invariant(schema.oneOf?.length === 9 && schema.oneOf.every((branch) => branch.type === 'object' && branch.additionalProperties === false), 'platform read response variants must be strict')
    else {
      invariant(schema.type === 'object' && schema.additionalProperties === false, `${name} must be strict`)
      invariant(Array.isArray(schema.required) && schema.required.length > 0, `${name} must define required fields`)
    }
    const compiled = compileJsonSchema(schema, schemaContext)
    if (!['event-type.schema.v1.json','event.schema.v1.json','nba.schema.v1.json','command.schema.v1.json','command-result.schema.v1.json','error.schema.v1.json','event-stream-response.schema.v1.json','platform-read-responses.schema.v1.json'].includes(name)) {
      const positive = exampleFor(schema, schemaContext)
      invariant(compiled(positive).length === 0, `${name} compiled positive instance failed: ${compiled(positive).join(',')}`)
      const negative = structuredClone(positive)
      delete negative[schema.required[0]]
      invariant(compiled(negative).length > 0, `${name} compiled negative instance was accepted`)
    }
  }
  const eventTypeValidator = compileJsonSchema(schemaMap.get('event-type.schema.v1.json'), schemaContext)
  invariant(eventTypeValidator(events.event_keys[0]).length === 0 && eventTypeValidator('unknown.event.completed.v1').length > 0, 'registered event type positive/negative validation failed')
  invariant(schemaMap.get('event.schema.v1.json')['x-source-command-constraint'], 'event source.command semantic constraint missing')
  invariant(schemaMap.get('command.schema.v1.json').allOf?.length > 0, 'creation command version constraint missing')
  invariant(schemaMap.get('command-result.schema.v1.json').allOf?.length >= 5, 'command result status semantics missing')
  invariant(schemaMap.get('error.schema.v1.json').oneOf?.length === api.error_experience.length, 'error code semantic branches drift')
  invariant(api.request_token.owner === 'client' && api.request_token.must_not_be_used_as === 'canonical idempotency key', 'request_token ownership/meaning drift')
  invariant(api.idempotency_key.owner === 'server' && api.idempotency_key.client_may_supply === false, 'idempotency_key must be server canonical')
  invariant(api.pagination.strategy === 'opaque_cursor' && api.resume.header === 'Last-Event-ID', 'pagination/resume contract missing')
  invariant(api.error_envelope.schema === 'error.schema.v1.json', 'error envelope schema binding missing')
  invariant(JSON.stringify(api.error_envelope.required) === JSON.stringify(schemaMap.get('error.schema.v1.json').required), 'error envelope required fields/schema drift')
  invariant(api.error_envelope.codes.length >= 10 && api.cache_invalidation.events.length >= 5, 'error/cache invalidation contract incomplete')
  invariant(api.error_experience.length === api.error_envelope.codes.length, 'error experience/code count drift')
  const errorCodes = new Set(api.error_envelope.codes)
  for (const item of api.error_experience) {
    invariant(errorCodes.has(item.code) && Number.isInteger(item.http_status) && typeof item.retryable === 'boolean', `${item.code} HTTP/retry mapping incomplete`)
    invariant(item.message_key && item.recovery_action && item.focus_target && ['polite','assertive'].includes(item.aria_live), `${item.code} recovery/focus/aria mapping incomplete`)
    invariant(['en','zh-CN','ar'].every((locale) => item.localized_copy[locale]), `${item.code} localized copy incomplete`)
  }
  invariant(api.error_negative_acceptance.length >= 6, 'error negative acceptance matrix incomplete')
  const errorValidator = compileJsonSchema(schemaMap.get('error.schema.v1.json'), schemaContext)
  const errorInstanceFor = (item) => ({ code:item.code, http_status:item.http_status, message_key:item.message_key, request_id:'123e4567-e89b-42d3-a456-426614174000', retryable:item.retryable, recovery_action:item.recovery_action, focus_target:item.focus_target, aria_live:item.aria_live, field_errors:null, current_version:null })
  for (const item of api.error_experience) {
    const positive = errorInstanceFor(item)
    invariant(errorValidator(positive).length === 0, `${item.code} semantic error instance failed`)
    const negative = { ...positive, retryable: !positive.retryable }
    invariant(errorValidator(negative).length > 0, `${item.code} retryability drift was accepted`)
  }
  const endpointKeys = new Set(api.endpoints.map((item) => `${item.method} ${item.path}`))
  for (const endpoint of ['GET /api/v4/work-items','POST /api/v4/commands','GET /api/v4/commands/{idempotency_key}','GET /api/v4/events/stream','GET /api/v4/platform/organizations','POST /api/v4/platform/support-session-requests','POST /api/v4/platform/support-session-requests/{support_session_request_id}/approve','GET /api/v4/platform/audit']) {
    invariant(endpointKeys.has(endpoint), `missing endpoint ${endpoint}`)
  }
  const endpoint = (method, endpointPath) => api.endpoints.find((item) => item.method === method && item.path === endpointPath)
  invariant(endpoint('POST', '/api/v4/commands').response_schema === 'command-result.schema.v1.json', 'command result schema binding missing')
  invariant(endpoint('GET', '/api/v4/commands/{idempotency_key}').response_schema === 'command-result.schema.v1.json', 'command lookup result schema binding missing')
  invariant(endpoint('GET', '/api/v4/events/stream').response_schema === 'event-stream-response.schema.v1.json', 'event stream response schema binding missing')
  const orgTransition = endpoint('POST', '/api/v4/platform/organizations/{organization_id}/transitions')
  const billingTransition = endpoint('POST', '/api/v4/platform/subscriptions/{subscription_id}/transitions')
  invariant(orgTransition.transition_policy.platform_owner.includes('closed') && !orgTransition.transition_policy.platform_ops.includes('closed'), 'platform_ops must not close organizations')
  invariant(billingTransition.transition_policy.platform_owner.includes('closed') && !billingTransition.transition_policy.platform_ops.includes('closed'), 'platform_ops must not close subscriptions')
  for (const transition of [orgTransition, billingTransition]) {
    invariant(transition.approval_required === true && transition.approval_status_required === 'approved' && transition.requester_must_differ_from_approver === true, `${transition.state_machine} lifecycle must require independent approved transition`)
    invariant(JSON.stringify(transition.approval_binding) === JSON.stringify(['approval_id','requested_by_actor_id','approved_by_actor_id','approval_event_id']), `${transition.state_machine} lifecycle approval binding incomplete`)
    const contract = payloads.entries.find((item) => item.command === transition.command)
    for (const schema of [contract.command_payload_schema, contract.event_payload_schema]) {
      invariant(['approval_id','approval_status','requested_by_actor_id','approved_by_actor_id','approval_event_id'].every((field) => schema.required.includes(field)), `${transition.state_machine} lifecycle payload approval facts incomplete`)
      invariant(schema['x-distinct']?.includes('requested_by_actor_id') && schema['x-distinct']?.includes('approved_by_actor_id'), `${transition.state_machine} requester/approver distinct constraint missing`)
      const validator = compileJsonSchema(schema, schemaContext)
      const valid = exampleFor(schema, schemaContext)
      valid.requested_by_actor_id = '123e4567-e89b-42d3-a456-426614174010'
      valid.approved_by_actor_id = '123e4567-e89b-42d3-a456-426614174011'
      invariant(validator(valid).length === 0, `${transition.state_machine} approved lifecycle payload failed`)
      invariant(validator({ ...valid, approved_by_actor_id:valid.requested_by_actor_id }).length > 0, `${transition.state_machine} self-approved lifecycle payload accepted`)
      invariant(validator({ ...valid, approval_status:'pending' }).length > 0, `${transition.state_machine} unapproved lifecycle payload accepted`)
    }
  }
  const supportRequest = endpoint('POST', '/api/v4/platform/support-session-requests')
  const supportApproval = endpoint('POST', '/api/v4/platform/support-session-requests/{support_session_request_id}/approve')
  invariant(JSON.stringify(supportRequest.roles) === JSON.stringify(['platform_support']) && supportRequest.command === 'request_support_session', 'platform_support may only request a support session')
  invariant(!supportApproval.roles.includes('platform_support') && supportApproval.requester_must_differ_from_approver === true && supportApproval.command === 'approve_support_session', 'support session approval must be independent')
  invariant(supportApproval.response_required.includes('approval_id') && supportApproval.response_required.includes('approved_by_actor_id'), 'support approval binding/result incomplete')
  const supportRevoke = endpoint('DELETE', '/api/v4/platform/support-sessions/{support_session_id}')
  invariant(supportRevoke.roles.includes('platform_support') && supportRevoke.authorization_policy.platform_support === 'own_requested_active_session_only' && supportRevoke.owner_binding === 'session.requested_by_actor_id == actor_id', 'platform_support revoke must be restricted to own requested active session')
  invariant(supportRevoke.authorization_policy.platform_owner === 'any_active_session' && supportRevoke.authorization_policy.platform_ops === 'any_active_session', 'owner/ops support revoke scope drift')
  const expectedReadVariants = ['organizations','support_sessions','plans','entitlements','seats','quotas','usage','invoice_references','audit']
  const platformReads = api.endpoints.filter((item) => item.method === 'GET' && item.response_schema === 'platform-read-responses.schema.v1.json')
  invariant(JSON.stringify(platformReads.map((item) => item.response_variant).sort()) === JSON.stringify([...expectedReadVariants].sort()), 'platform read endpoint/schema coverage drift')
  const dispositions = endpoint('POST', '/api/v4/work-items/{work_item_id}/dispositions')
  invariant(JSON.stringify(dispositions.allowed_commands) === JSON.stringify(['start_work_item','complete_work_item','snooze_work_item','skip_work_item','reassign_work_item']), 'work-item disposition command coverage drift')

  invariant(events.event_keys.length === new Set(events.event_keys).size, 'duplicate event key')
  invariant(events.event_keys.every((key, index, all) => index === 0 || all[index - 1] < key), 'event key registry must be sorted')
  invariant(!eventModel.includes('`...'), 'event model contains abbreviated event key')
  const modelKeys = [...eventModel.matchAll(/`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}\.v[1-9][0-9]*)`/g)].map((match) => match[1])
  invariant(modelKeys.every((key) => events.event_keys.includes(key)), `event model contains unregistered key: ${modelKeys.find((key) => !events.event_keys.includes(key))}`)
  invariant(payloads.entries.length === events.event_keys.length, 'every canonical event must have event/command payload schemas')
  invariant(JSON.stringify(payloads.entries.map((item) => item.event_type).sort()) === JSON.stringify([...events.event_keys].sort()), 'payload registry event set drift')
  invariant(new Set(payloads.entries.map((item) => item.command)).size === payloads.entries.length, 'command discriminator must be unique')
  const commandKeys = new Set(payloads.entries.map((item) => item.command))
  for (const endpoint of api.endpoints.filter((item) => item.command)) invariant(commandKeys.has(endpoint.command), `${endpoint.method} ${endpoint.path} references unknown command ${endpoint.command}`)
  invariant(dispositions.allowed_commands.every((command) => commandKeys.has(command)), 'work-item disposition endpoint references unknown command')
  const requiredSuccessEvents = [
    'real_estate.offer.accepted.v1','real_estate.offer.rejected.v1','real_estate.offer.withdrawn.v1','real_estate.deal.cancelled.v1','real_estate.deal.contract_reference_recorded.v1','real_estate.deal.payment_reference_recorded.v1',
    'retail.quotation.accepted.v1','retail.order.created.v1','retail.order.reserved.v1','retail.order.fulfilled.v1','retail.purchase_order.issued.v1','retail.receipt.posted.v1','retail.inventory.movement_recorded.v1','retail.delivery.completed.v1','retail.finance.confirmed.v1','retail.reconciliation.completed.v1',
    'workflow.work_item.started.v1','workflow.work_item.completed.v1','workflow.work_item.snoozed.v1','workflow.work_item.skipped.v1','workflow.work_item.reassigned.v1'
  ]
  invariant(requiredSuccessEvents.every((eventType) => events.event_keys.includes(eventType)), `successful business chain missing ${requiredSuccessEvents.find((eventType) => !events.event_keys.includes(eventType))}`)
  for (const entry of payloads.entries) {
    for (const schemaName of ['event_payload_schema','command_payload_schema']) {
      const schema = entry[schemaName]
      invariant(schema.type === 'object' && schema.additionalProperties === false && schema.required.length > 0, `${entry.event_type}/${schemaName} must be strict and discriminated`)
      const compiled = compileJsonSchema(schema, schemaContext)
      const positive = exampleFor(schema, schemaContext)
      if (schema['x-distinct']) schema['x-distinct'].forEach((field, index) => { positive[field] = `123e4567-e89b-42d3-a456-42661417400${index}` })
      invariant(compiled(positive).length === 0, `${entry.event_type}/${schemaName} positive instance failed`)
      const negative = structuredClone(positive)
      delete negative[schema.required[0]]
      invariant(compiled(negative).length > 0, `${entry.event_type}/${schemaName} negative instance was accepted`)
    }
  }
  const purchaseRequest = payloads.entries.find((item) => item.command === 'create_purchase_request').command_payload_schema
  const purchaseLine = purchaseRequest.properties.lines.items
  invariant(purchaseRequest.required.includes('currency') && purchaseLine.additionalProperties === false, 'purchase request currency/strict line contract missing')
  invariant(JSON.stringify(purchaseLine.required) === JSON.stringify(['sku_id','quantity','unit_price_minor']), 'purchase request line required fields drift')
  invariant(purchaseLine.properties.quantity.exclusiveMinimum === 0 && purchaseLine.properties.unit_price_minor.minimum === 0, 'purchase request line numeric minimums missing')
  const receipt = payloads.entries.find((item) => item.command === 'post_purchase_receipt')
  for (const schema of [receipt.command_payload_schema, receipt.event_payload_schema]) {
    const line = schema.properties.lines.items
    invariant(line.additionalProperties === false && line['x-receipt-line-constraint'] === true, 'AC-30 receipt line strict variance contract missing')
    invariant(JSON.stringify(line.required) === JSON.stringify(['po_line_id','sku_id','received_qty','unit','expected_qty','variance','over_receipt_disposition']), 'AC-30 receipt facts incomplete')
    invariant(line.properties.received_qty.exclusiveMinimum === 0 && JSON.stringify(line.properties.over_receipt_disposition.enum) === JSON.stringify(['not_applicable','approved_exception']), 'AC-30 receipt quantity/disposition rule missing')
    const lineValidator = compileJsonSchema(line, schemaContext)
    const validLine = exampleFor(line, schemaContext)
    invariant(lineValidator(validLine).length === 0 && lineValidator({ ...validLine, received_qty: validLine.expected_qty + 1, variance:1, over_receipt_disposition:'not_applicable' }).length > 0, 'AC-30 over-receipt disposition negative failed')
  }
  const movement = payloads.entries.find((item) => item.command === 'record_inventory_movement')
  for (const schema of [movement.command_payload_schema, movement.event_payload_schema]) invariant(['quantity','unit','direction','reason_code','source_reference'].every((field) => schema.required.includes(field)) && schema.properties.quantity.exclusiveMinimum === 0, 'AC-29 inventory movement facts incomplete')
  const finance = payloads.entries.find((item) => item.command === 'confirm_retail_finance')
  for (const schema of [finance.command_payload_schema, finance.event_payload_schema]) invariant(['amount_minor','currency','reference'].every((field) => schema.required.includes(field)) && schema.properties.amount_minor.minimum === 1, 'AC-31 finance confirmation facts incomplete')
  for (const command of ['record_retail_payment_allocation','record_retail_refund','complete_retail_reconciliation']) invariant(payloads.entries.some((item) => item.command === command), `AC-32 missing ${command} fact contract`)
  const supportRequested = payloads.entries.find((item) => item.command === 'request_support_session')
  const supportApproved = payloads.entries.find((item) => item.command === 'approve_support_session')
  invariant(supportRequested.event_type === 'platform.support_session.requested.v1' && supportApproved.event_type === 'platform.support_session.created.v1', 'support request/approval event chain drift')
  invariant(['approval_id','requested_by_actor_id','approved_by_actor_id'].every((field) => supportApproved.event_payload_schema.required.includes(field)), 'approved support session attribution incomplete')
  const approvedSupportValidator = compileJsonSchema(supportApproved.event_payload_schema, schemaContext)
  const sameActorApproval = exampleFor(supportApproved.event_payload_schema, schemaContext)
  invariant(approvedSupportValidator(sameActorApproval).some((error) => error.includes('distinct fields')), 'support requester self-approval was accepted')
  const viewingContract = payloads.entries.find((item) => item.command === 'schedule_viewing')
  const nbaValidator = compileJsonSchema(schemaMap.get('nba.schema.v1.json'), schemaContext)
  const nbaInstance = exampleFor(schemaMap.get('nba.schema.v1.json'), schemaContext)
  nbaInstance.primary_action.command = viewingContract.command
  nbaInstance.primary_action.expected_event = viewingContract.event_type
  invariant(nbaValidator(nbaInstance).length === 0, 'NBA command/event positive pair failed')
  nbaInstance.primary_action.expected_event = 'real_estate.viewing.completed.v1'
  invariant(nbaValidator(nbaInstance).some((error) => error.includes('command-event constraint')), 'NBA mismatched command/event pair was accepted')

  const eventValidator = compileJsonSchema(schemaMap.get('event.schema.v1.json'), schemaContext)
  const eventInstance = exampleFor(schemaMap.get('event.schema.v1.json'), schemaContext)
  eventInstance.event_type = viewingContract.event_type
  eventInstance.payload = exampleFor(viewingContract.event_payload_schema, schemaContext)
  eventInstance.source.command = viewingContract.command
  invariant(eventValidator(eventInstance).length === 0, 'event discriminator positive instance failed')
  const wrongSourceCommand = structuredClone(eventInstance)
  wrongSourceCommand.source.command = 'complete_work_item'
  invariant(eventValidator(wrongSourceCommand).some((error) => error.includes('source-command constraint')), 'event source.command mismatch was accepted')
  const eventStreamValidator = compileJsonSchema(schemaMap.get('event-stream-response.schema.v1.json'), schemaContext)
  const eventStreamInstance = exampleFor(schemaMap.get('event-stream-response.schema.v1.json'), schemaContext)
  eventStreamInstance.event = structuredClone(eventInstance)
  invariant(eventStreamValidator(eventStreamInstance).length === 0, 'event stream response positive instance failed')
  const invalidEventStream = structuredClone(eventStreamInstance)
  delete invalidEventStream.event
  invariant(eventStreamValidator(invalidEventStream).length > 0, 'event stream response negative instance was accepted')
  delete eventInstance.payload[viewingContract.event_payload_schema.required[0]]
  invariant(eventValidator(eventInstance).length > 0, 'event discriminator negative payload was accepted')

  const commandValidator = compileJsonSchema(schemaMap.get('command.schema.v1.json'), schemaContext)
  const commandInstance = exampleFor(schemaMap.get('command.schema.v1.json'), schemaContext)
  commandInstance.command = viewingContract.command
  commandInstance.payload = exampleFor(viewingContract.command_payload_schema, schemaContext)
  invariant(commandValidator(commandInstance).length === 0, 'command discriminator positive instance failed')
  commandInstance.command = 'unknown_command'
  invariant(commandValidator(commandInstance).length > 0, 'unknown command discriminator was accepted')
  const creationContract = payloads.entries.find((item) => item.command === 'provision_organization')
  const creationCommand = { ...exampleFor(schemaMap.get('command.schema.v1.json'), schemaContext), command:creationContract.command, expected_version:0, payload:exampleFor(creationContract.command_payload_schema, schemaContext) }
  invariant(commandValidator(creationCommand).length === 0, 'creation command version zero was rejected')
  invariant(commandValidator({ ...creationCommand, expected_version:1 }).length > 0, 'creation command nonzero version was accepted')
  const existingCommand = { ...creationCommand, command:viewingContract.command, expected_version:1, payload:exampleFor(viewingContract.command_payload_schema, schemaContext) }
  invariant(commandValidator(existingCommand).length === 0 && commandValidator({ ...existingCommand, expected_version:0 }).length > 0, 'existing aggregate command version rule failed')

  const commandResultValidator = compileJsonSchema(schemaMap.get('command-result.schema.v1.json'), schemaContext)
  invariant(schemaMap.get('command-result.schema.v1.json')['x-error-request-id-match'] === true, 'command result/error request_id binding missing')
  const resultBase = (status) => ({ request_token:'123e4567-e89b-42d3-a456-426614174000', idempotency_key:'canonical-key-0001', request_id:'123e4567-e89b-42d3-a456-426614174001', correlation_id:'123e4567-e89b-42d3-a456-426614174002', status, expected_event:null, event_id:null, error:null })
  invariant(commandResultValidator(resultBase('accepted')).length === 0, 'accepted command result failed')
  const completedResult = { ...resultBase('completed'), expected_event:viewingContract.event_type, event_id:'123e4567-e89b-42d3-a456-426614174003' }
  invariant(commandResultValidator(completedResult).length === 0, 'completed command result failed')
  invariant(commandResultValidator({ ...completedResult, event_id:null }).length > 0, 'completed result without event_id was accepted')
  invariant(commandResultValidator({ ...completedResult, expected_event:'unknown.event.completed.v1' }).length > 0, 'completed result with unregistered event was accepted')
  const approvalBase = resultBase('approval_pending')
  const approvalError = { ...errorInstanceFor(api.error_experience.find((item) => item.code === 'APPROVAL_REQUIRED')), request_id:approvalBase.request_id }
  const approvalResult = { ...approvalBase, error:approvalError }
  invariant(commandResultValidator(approvalResult).length === 0, 'approval-pending result failed')
  invariant(commandResultValidator({ ...approvalResult, error:{ ...errorInstanceFor(api.error_experience.find((item) => item.code === 'FORBIDDEN')), request_id:approvalBase.request_id } }).length > 0, 'approval-pending result accepted non-approval error')
  const deniedBase = resultBase('denied')
  const deniedResult = { ...deniedBase, error:{ ...errorInstanceFor(api.error_experience.find((item) => item.code === 'FORBIDDEN')), request_id:deniedBase.request_id } }
  invariant(commandResultValidator(deniedResult).length === 0 && commandResultValidator({ ...deniedResult, error:null }).length > 0, 'denied result error rule failed')
  invariant(commandResultValidator({ ...deniedResult, error:{ ...errorInstanceFor(api.error_experience.find((item) => item.code === 'INTERNAL_ERROR')), request_id:deniedBase.request_id } }).length > 0, 'denied result accepted failure-class error')
  invariant(commandResultValidator({ ...deniedResult, error:{ ...deniedResult.error, request_id:'123e4567-e89b-42d3-a456-426614174099' } }).some((error) => error.includes('request_id mismatch')), 'command result accepted mismatched error request_id')
  const failedBase = resultBase('failed')
  const failedResult = { ...failedBase, error:{ ...errorInstanceFor(api.error_experience.find((item) => item.code === 'INTERNAL_ERROR')), request_id:failedBase.request_id } }
  invariant(commandResultValidator(failedResult).length === 0 && commandResultValidator({ ...failedResult, error:null }).length > 0, 'failed result error rule failed')
  invariant(commandResultValidator({ ...failedResult, error:{ ...errorInstanceFor(api.error_experience.find((item) => item.code === 'FORBIDDEN')), request_id:failedBase.request_id } }).length > 0, 'failed result accepted denial-class error')

  const platformReadValidator = compileJsonSchema(schemaMap.get('platform-read-responses.schema.v1.json'), schemaContext)
  for (const branch of schemaMap.get('platform-read-responses.schema.v1.json').oneOf) {
    const positive = exampleFor(branch, schemaContext)
    invariant(platformReadValidator(positive).length === 0, `${positive.resource_type} read response failed`)
    invariant(platformReadValidator({ ...positive, unexpected:true }).length > 0, `${positive.resource_type} read response accepted additional property`)
  }

  invariant(sources.accessed_at === '2026-08-03' && sources.sources.length >= 20, 'official source registry access date/count missing')
  invariant(sources.sources.every((item) => /^OFF-/.test(item.source_id) && item.url.startsWith('https://') && item.locator), 'official source id/url/locator incomplete')
  invariant(sources.immutable_registry_metadata_snapshot === 'research-evidence-snapshot.v1.json', 'official source registry metadata snapshot binding missing')
  invariant(sourceEvidence.snapshot_scope === 'registry metadata only; no webpage body, quote, or content snapshot is claimed', 'official source snapshot scope overclaims webpage content')
  invariant(sourceEvidence.records.length === sources.sources.length, 'official source evidence record count drift')
  invariant(gitProvenance.isTracked(`${contractDir}/${sources.immutable_registry_metadata_snapshot}`), 'official source registry metadata snapshot must be tracked')
  for (const source of sources.sources) {
    const record = sourceEvidence.records.find((item) => item.source_id === source.source_id)
    invariant(record && ['title','url','locator'].every((key) => record[key] === source[key]) && record.accessed_at === sources.accessed_at, `${source.source_id} evidence snapshot drift`)
    const fact = { source_id:record.source_id, title:record.title, url:record.url, locator:record.locator, accessed_at:record.accessed_at }
    invariant(createHash('sha256').update(JSON.stringify(fact)).digest('hex') === record.record_sha256, `${source.source_id} evidence hash mismatch`)
  }
  invariant(gitProvenance.isTracked(`${contractDir}/legacy-role-mapping.v1.json`), 'legacy role mapping must be tracked')
  for (const source of roleMapping.sources) invariant(gitProvenance.candidateBlob(source.path) === source.blob, `${source.issue} role mapping source blob drift`)
  const expectedRoleMapping = { admin:'org_admin', boss:'org_owner', designer:'specialist', finance:'finance', operator:'operations', sales:'sales_agent' }
  invariant(roleMapping.legacy_to_canonical.length === 6 && roleMapping.legacy_to_canonical.every((item) => expectedRoleMapping[item.legacy_role] === item.canonical_role && item.scope === 'organization'), 'SAM-18/19 legacy role mapping drift')
  invariant(roleMapping.legacy_to_canonical.find((item) => item.legacy_role === 'boss').requires_human_review === true, 'org_owner migration must require human review')
  for (const role of ['platform_owner','platform_ops','platform_support','platform_auditor']) invariant(platform.includes(`\`${role}\``), `platform role ${role} missing`)
  for (const state of ['provisioning','read_only','suspended','export_only','closed']) invariant(platform.includes(`\`${state}\``), `organization lifecycle ${state} missing`)
  for (const state of ['trial','active','grace','dunning','suspended','closed']) invariant(platform.includes(`\`${state}\``), `billing lifecycle ${state} missing`)
  for (const marker of ['provisional budgets','暂定预算','浏览器/设备','数据规模','A11Y-01','release_sha','assistive_technology']) invariant(nfr.includes(marker), `nonfunctional gate missing ${marker}`)
  return { requirements: idMap.size, frontend_requirements: feIds.length, acceptance: acRows.length, screens: screenIds.length, routes: actualFiles.length, event_keys: events.event_keys.length, payload_contracts: payloads.entries.length, sources: sources.sources.length, source_evidence: sourceEvidence.records.length, schemas: schemas.length, error_experiences: api.error_experience.length, role_mappings: roleMapping.legacy_to_canonical.length }
}

export function validateV4FrontendContracts(root = defaultRoot) {
  return validateDocuments(loadDocuments(root), root)
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const result = validateV4FrontendContracts(process.argv[2] ? path.resolve(process.argv[2]) : defaultRoot)
  process.stdout.write(`V4 frontend contracts passed: ${JSON.stringify(result)}\n`)
}
