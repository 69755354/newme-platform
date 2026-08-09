import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('every tracked gitlink has a declared .gitmodules path', () => {
  const stagedEntries = execFileSync('git', ['ls-files', '--stage'], {
    encoding: 'utf8',
  });
  const gitlinks = stagedEntries
    .split(/\r?\n/)
    .filter((line) => line.startsWith('160000 '))
    .map((line) => line.slice(line.indexOf('\t') + 1))
    .sort();

  const declaredPaths = existsSync('.gitmodules')
    ? [...readFileSync('.gitmodules', 'utf8').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)]
        .map((match) => match[1])
        .sort()
    : [];

  assert.deepEqual(gitlinks, declaredPaths);
});
