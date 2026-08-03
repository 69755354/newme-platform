import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const skill = resolve(scripts, '..')
const repo = resolve(skill, '..', '..')
const candidateSha = '80f7e2349324900cf5852f31b3a0459532fd6c1a'
const previousSha = 'f2bd6576a0723fea58a13926baef2dedcc37da8e'

function run(script, input, env = {}) {
  return spawnSync(process.execPath, [resolve(scripts, script), ...(input ? [input] : [])], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

async function writeJson(directory, name, value) {
  const path = resolve(directory, name)
  await writeFile(path, JSON.stringify(value))
  return path
}

async function validWorkPackage() {
  const value = JSON.parse(await readFile(resolve(skill, 'assets/work-package.template.json'), 'utf8'))
  value.linearId = 'SAM-78'
  value.v4Ids = ['V4-PF-001']
  value.baseSha = previousSha
  return value
}

async function validReleaseEvidence() {
  const value = JSON.parse(await readFile(resolve(skill, 'assets/release-evidence.template.json'), 'utf8'))
  value.candidateSha = candidateSha
  value.previousReleaseSha = previousSha
  value.ci.headSha = candidateSha
  value.artifact.sha256 = 'a1'.repeat(32)
  value.manifest.gitSha = candidateSha
  value.rollback.targetSha = previousSha
  return value
}

test('governance package validates', () => {
  const result = run('validate-governance.mjs')
  assert.equal(result.status, 0, result.stderr)
})

test('governance validation rejects unstructured gates and duplicate issue rows', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'newme-v4-governance-'))
  try {
    await cp(resolve(repo, 'docs/v4'), resolve(directory, 'docs/v4'), { recursive: true })
    await cp(skill, resolve(directory, 'skills/newme-v4-delivery'), { recursive: true })
    const prdPath = resolve(directory, 'docs/v4/V4_SAAS_PRD.md')
    const originalPrd = await readFile(prdPath, 'utf8')
    await writeFile(prdPath, originalPrd.replace('- **G8 Pilot:**', '- G8 Pilot:'))
    let result = run('validate-governance.mjs', undefined, { V4_GOVERNANCE_ROOT: directory })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /structured gates G0\.\.G8/)

    await writeFile(prdPath, originalPrd)
    const backlogPath = resolve(directory, 'docs/v4/V4_EXECUTION_BACKLOG.md')
    const backlog = await readFile(backlogPath, 'utf8')
    const row = backlog.split(/\r?\n/).find((line) => line.startsWith('| P0 | [SAM-77]'))
    await writeFile(backlogPath, backlog.replace(row, `${row}\n${row}`))
    result = run('validate-governance.mjs', undefined, { V4_GOVERNANCE_ROOT: directory })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /exactly one ordered table row/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('work-package validator accepts filled evidence and rejects template placeholders', async () => {
  const template = resolve(skill, 'assets/work-package.template.json')
  assert.notEqual(run('validate-work-package.mjs', template).status, 0)

  const directory = await mkdtemp(resolve(tmpdir(), 'newme-v4-work-package-'))
  try {
    const value = await validWorkPackage()
    assert.equal(run('validate-work-package.mjs', await writeJson(directory, 'valid.json', value)).status, 0)

    value.linearId = 'SAM-000'
    let result = run('validate-work-package.mjs', await writeJson(directory, 'linear-placeholder.json', value))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /non-placeholder SAM-N/)

    value.linearId = 'SAM-78'
    value.baseSha = '0'.repeat(40)
    result = run('validate-work-package.mjs', await writeJson(directory, 'sha-placeholder.json', value))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /non-placeholder lowercase 40-character Git SHA/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release validator accepts filled evidence and rejects the placeholder template', async () => {
  const template = resolve(skill, 'assets/release-evidence.template.json')
  assert.notEqual(run('validate-release-evidence.mjs', template).status, 0)

  const directory = await mkdtemp(resolve(tmpdir(), 'newme-v4-release-'))
  try {
    const value = await validReleaseEvidence()
    assert.equal(run('validate-release-evidence.mjs', await writeJson(directory, 'valid.json', value)).status, 0)

    value.cleanup.counts.fixtures = 1
    const result = run('validate-release-evidence.mjs', await writeJson(directory, 'residue.json', value))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /cleanup residue/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release validator rejects homogeneous digests and duplicate release SHAs', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'newme-v4-digests-'))
  try {
    const value = await validReleaseEvidence()
    value.candidateSha = 'f'.repeat(40)
    value.ci.headSha = value.candidateSha
    value.manifest.gitSha = value.candidateSha
    let result = run('validate-release-evidence.mjs', await writeJson(directory, 'candidate-placeholder.json', value))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /candidateSha must be a non-placeholder/)

    Object.assign(value, await validReleaseEvidence())
    value.previousReleaseSha = value.candidateSha
    value.rollback.targetSha = value.candidateSha
    result = run('validate-release-evidence.mjs', await writeJson(directory, 'same-sha.json', value))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must differ/)

    Object.assign(value, await validReleaseEvidence())
    value.artifact.sha256 = 'a'.repeat(64)
    result = run('validate-release-evidence.mjs', await writeJson(directory, 'artifact-placeholder.json', value))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /artifact sha256 must be a non-placeholder/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release evidence rejects secret-shaped keys and values', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'newme-v4-secret-'))
  try {
    for (const key of ['api_key', 'private-key', 'accessKey', 'passphrase', 'credential', 'clientCert']) {
      const value = await validReleaseEvidence()
      value[key] = 'redacted'
      const result = run('validate-release-evidence.mjs', await writeJson(directory, `${key.replace(/\W/g, '_')}.json`, value))
      assert.notEqual(result.status, 0, key)
      assert.match(result.stderr, /forbidden secret-shaped field/)
    }

    for (const [name, secretValue] of [
      ['bearer', 'Bearer abc.def.ghi'],
      ['github', 'github_pat_AAAABBBBCCCCDDDDEEEE'],
      ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'],
      ['uri', 'postgresql://user:password@example.invalid/db']
    ]) {
      const value = await validReleaseEvidence()
      value.notes = secretValue
      const result = run('validate-release-evidence.mjs', await writeJson(directory, `${name}.json`, value))
      assert.notEqual(result.status, 0, name)
      assert.match(result.stderr, /forbidden secret-shaped value/)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release migration state requires exact non-empty versions or explicit not-required', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'newme-v4-migrations-'))
  try {
    const value = await validReleaseEvidence()
    value.migrations = { status: 'verified', versions: [] }
    let result = run('validate-release-evidence.mjs', await writeJson(directory, 'empty-verified.json', value))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /non-empty unique versions/)

    value.migrations.versions = ['20260730100000']
    assert.equal(run('validate-release-evidence.mjs', await writeJson(directory, 'verified.json', value)).status, 0)

    value.migrations = { status: 'not-required', versions: ['20260730100000'] }
    result = run('validate-release-evidence.mjs', await writeJson(directory, 'not-required-with-version.json', value))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must have an empty versions list/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
