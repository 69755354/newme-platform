#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const STAGING_ORIGIN = 'https://staging.newme.ae';
const MAX_OUTPUT_CHARS = 16_000;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function redactSensitive(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, '$1[REDACTED]')
    .replace(/(cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:service_role|supabase_[a-z_]*key|password|token)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED_SECRET]');
}

export function validateHost(host) {
  if (!host || !SAFE_HOST.test(host)) {
    throw new Error('SAM54_FAIL_CLOSED: --host must be a plain hostname or IPv4 address');
  }
  return host;
}

export function parseArgs(argv) {
  const options = { host: '', identityFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--host') options.host = argv[++index] ?? '';
    else if (value === '--identity-file') options.identityFile = argv[++index] ?? '';
    else throw new Error(`SAM54_FAIL_CLOSED: unsupported argument ${value}`);
  }
  options.host = validateHost(options.host);
  if (!options.identityFile) throw new Error('SAM54_FAIL_CLOSED: --identity-file is required');
  return options;
}

export function diagnosticCommands() {
  return [
    ['service', 'systemctl is-active newme-staging.service'],
    ['release', 'readlink -f /opt/newme-staging/current && git -C /opt/newme-staging/current rev-parse HEAD'],
    ['health', `curl -fsS --max-time 8 ${STAGING_ORIGIN}/api/health || true`],
    ['auth_me_status', `curl -sS -o /dev/null -w '%{http_code}' --max-time 8 ${STAGING_ORIGIN}/api/auth/me || true`],
    ['recent_auth_errors', "journalctl -u newme-staging.service --since '-15 min' --no-pager -o short-iso | grep -Ei '401|unauthor|forbidden|error|fatal|exception' | tail -n 100 || true"],
    ['disk', 'df -h /opt/newme-staging && du -sh /opt/newme-staging 2>/dev/null || true'],
  ];
}

export function buildRemoteScript() {
  const commands = diagnosticCommands()
    .map(([name, command]) => `printf '\\n--- ${name} ---\\n'; (${command})`)
    .join('; ');
  return [
    'set -eu',
    'test -d /opt/newme-staging',
    'systemctl cat newme-staging.service >/dev/null',
    commands,
  ].join('; ');
}

export function runDiagnostic({ host, identityFile, execute = execFileSync }) {
  const output = execute('ssh', [
    '-i', identityFile,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
    host,
    'sh', '-lc', buildRemoteScript(),
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });

  return {
    target: 'staging',
    origin: STAGING_ORIGIN,
    collectedAt: new Date().toISOString(),
    output: redactSensitive(output).slice(0, MAX_OUTPUT_CHARS),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    process.stdout.write(`${JSON.stringify(runDiagnostic(options), null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown diagnostic failure';
    process.stderr.write(`${redactSensitive(message)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
