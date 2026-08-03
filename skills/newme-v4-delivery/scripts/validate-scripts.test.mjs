import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const skill = resolve(scripts, '..')

function run(script, input) {
  return spawnSync(process.execPath, [resolve(scripts, script), ...(input ? [input] : [])], {
    encoding: 'utf8'
  })
}

test('governance package validates', () => {
  const result = run('validate-governance.mjs')
  assert.equal(result.status, 0, result.stderr)
})

test('work-package template validates and malformed Linear ID fails closed', async () => {
  const template = resolve(skill, 'assets/work-package.template.json')
  assert.equal(run('validate-work-package.mjs', template).status, 0)

  const directory = await mkdtemp(resolve(tmpdir(), 'newme-v4-work-package-'))
  try {
    const value = JSON.parse(await readFile(template, 'utf8'))
    value.linearId = 'INVALID-1'
    const invalid = resolve(directory, 'invalid.json')
    await writeFile(invalid, JSON.stringify(value))
    const result = run('validate-work-package.mjs', invalid)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /linearId must match SAM-N/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release template validates and non-zero residue fails closed', async () => {
  const template = resolve(skill, 'assets/release-evidence.template.json')
  assert.equal(run('validate-release-evidence.mjs', template).status, 0)

  const directory = await mkdtemp(resolve(tmpdir(), 'newme-v4-release-'))
  try {
    const value = JSON.parse(await readFile(template, 'utf8'))
    value.cleanup.counts.fixtures = 1
    const invalid = resolve(directory, 'residue.json')
    await writeFile(invalid, JSON.stringify(value))
    const result = run('validate-release-evidence.mjs', invalid)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /cleanup residue/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release evidence rejects secret-shaped fields', async () => {
  const template = resolve(skill, 'assets/release-evidence.template.json')
  const directory = await mkdtemp(resolve(tmpdir(), 'newme-v4-secret-'))
  try {
    const value = JSON.parse(await readFile(template, 'utf8'))
    value.secretToken = 'redacted'
    const invalid = resolve(directory, 'secret.json')
    await writeFile(invalid, JSON.stringify(value))
    const result = run('validate-release-evidence.mjs', invalid)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /forbidden secret-shaped field/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
