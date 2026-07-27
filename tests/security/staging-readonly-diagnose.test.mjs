import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRemoteScript,
  diagnosticCommands,
  parseArgs,
  redactSensitive,
  runDiagnostic,
  validateHost,
} from '../../scripts/staging-readonly-diagnose.mjs';

test('SAM-54 accepts only explicit safe staging SSH host input', () => {
  assert.equal(validateHost('staging.example.test'), 'staging.example.test');
  assert.equal(validateHost('203.0.113.10'), '203.0.113.10');
  assert.throws(() => validateHost('-oProxyCommand=evil'), /SAM54_FAIL_CLOSED/);
  assert.throws(() => parseArgs(['--host', 'staging.example.test']), /identity-file is required/);
  assert.throws(() => parseArgs(['--host', 'staging.example.test', '--identity-file', 'id', '--target', 'production']), /unsupported argument/);
});

test('SAM-54 remote command set is fixed, staging-only, and read-only', () => {
  const script = buildRemoteScript();
  const names = diagnosticCommands().map(([name]) => name);
  assert.deepEqual(names, ['service', 'release', 'health', 'auth_me_status', 'recent_auth_errors', 'disk']);
  assert.match(script, /newme-staging\.service/);
  assert.match(script, /\/opt\/newme-staging/);
  assert.match(script, /https:\/\/staging\.newme\.ae/);
  assert.doesNotMatch(script, /\b(?:rm|mv|cp|install|chmod|chown|systemctl\s+(?:restart|start|stop|reload)|sudo|psql|supabase|git\s+push)\b/i);
});

test('SAM-54 redacts common credential material before emitting a report', () => {
  const redacted = redactSensitive('Authorization: Bearer abc.def.ghi\nCookie=session=secret\ntoken=secret-value\neyJabcdefgh.abcdefgh.abcdefgh');
  assert.doesNotMatch(redacted, /secret|abc\.def\.ghi|eyJabcdefgh/);
  assert.match(redacted, /REDACTED/);
});

test('SAM-54 emits a bounded staging report without executing arbitrary commands', () => {
  let executable = '';
  let args = [];
  const report = runDiagnostic({
    host: 'staging.example.test',
    identityFile: '/tmp/staging-key',
    execute(command, commandArgs) {
      executable = command;
      args = commandArgs;
      return 'service_role=should-not-leak\nhealth=ok';
    },
  });

  assert.equal(executable, 'ssh');
  assert.ok(args.includes('staging.example.test'));
  assert.equal(report.target, 'staging');
  assert.equal(report.origin, 'https://staging.newme.ae');
  assert.doesNotMatch(report.output, /should-not-leak/);
  assert.match(report.output, /REDACTED/);
});
