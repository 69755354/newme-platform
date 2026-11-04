// Unit tests for the pure parts of the E2E regression suite (e2e/regression):
// target/production guard, accounts parsing (no password leaks), bug catalogue
// coverage and the Markdown report generator. No browser, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = 'e2e/regression';
const target = await import(path.resolve(root, 'lib/target.mjs'));
const accounts = await import(path.resolve(root, 'lib/accounts.mjs'));
const bugs = await import(path.resolve(root, 'lib/bugs.mjs'));
const report = await import(path.resolve(root, 'lib/report.mjs'));

const ID = '11111111-2222-3333-4444-555555555555';

test('full suite refuses production; smoke needs the explicit opt-in', () => {
  assert.throws(() => target.resolveTarget({ E2E_BASE_URL: 'https://app.newme.ae', E2E_ACCOUNTS_FILE: 'x' }), /E2E_ALLOW_PRODUCTION/);
  assert.throws(() => target.resolveTarget({ E2E_BASE_URL: 'https://app.newme.ae', E2E_ALLOW_PRODUCTION: '1', E2E_SUITE: 'full', E2E_ACCOUNTS_FILE: 'x' }), /smoke/);
  const t = target.resolveTarget({ E2E_BASE_URL: 'https://app.newme.ae', E2E_ALLOW_PRODUCTION: '1', E2E_ACCOUNTS_FILE: 'x' });
  assert.equal(t.suite, 'smoke');
  assert.equal(t.allowWrites, false);
  assert.throws(() => target.resolveTarget({ E2E_BASE_URL: 'https://u:p@staging.example' }), /credentials/);
});

test('production guard blocks writes except the one marked lead', () => {
  const base = { origin: 'https://app.newme.ae' };
  const get = target.productionRequestDecision({ ...base, method: 'GET', url: 'https://app.newme.ae/api/leads/list' });
  assert.equal(get.allow, true);
  const write = target.productionRequestDecision({ ...base, method: 'POST', url: 'https://app.newme.ae/api/leads', postData: '{}' });
  assert.equal(write.allow, false);
  const marked = target.productionRequestDecision({ ...base, method: 'POST', url: `https://app.newme.ae/api/leads/${ID}/assignment`, allowLeadId: ID });
  assert.equal(marked.allow, true);
  const other = target.productionRequestDecision({ ...base, method: 'POST', url: 'https://app.newme.ae/api/leads/other/assignment', allowLeadId: ID });
  assert.equal(other.allow, false);
  const third = target.productionRequestDecision({ ...base, method: 'POST', url: 'https://example.com/x' });
  assert.equal(third.allow, false);
  assert.equal(target.isMetaTraffic('https://www.facebook.com/tr?id=1'), true);
  assert.equal(target.isMetaTraffic('https://app.newme.ae/api/leads/meta-capi'), true);
  assert.equal(target.isMetaTraffic('https://app.newme.ae/api/leads/list'), false);
});

test('the public-origin replay only applies to loopback targets', () => {
  assert.equal(target.publicOriginFor('http://127.0.0.1:3101', {}), 'https://staging.newme.ae');
  assert.equal(target.publicOriginFor('https://app.newme.ae', {}), null);
});

test('accounts parse in both layouts and never expose passwords when serialised', () => {
  const pipe = `# c\nboss|Boss One|boss@example.com|s3cretpass-A|${ID}\nadmin|Adm|a@example.com|s3cretpass-B|${ID}\noperator|Op|o@example.com|s3cretpass-C|${ID}\nsales|Sam Sales A|sa@example.com|s3cretpass-D|${ID}\nsales|Sam Sales B|sb@example.com|s3cretpass-E|${ID}\nfinance|F|f@example.com|s3cretpass-F|${ID}\ndesigner|D|d@example.com|s3cretpass-G|${ID}\n`;
  const a = accounts.parseAccounts(pipe);
  assert.deepEqual(accounts.missingRoles(a), []);
  assert.equal(a.salesA.email, 'sa@example.com');
  assert.equal(a.salesB.email, 'sb@example.com');
  assert.equal(a.boss.password, 's3cretpass-A');
  assert.ok(!JSON.stringify(a).includes('s3cretpass'));
  assert.ok(!String(a.boss).includes('s3cretpass'));
  const tab = `sales_a\tsa@example.com\ts3cretpass-X\tsales\t${ID}`;
  const t = accounts.parseAccounts(tab);
  assert.equal(t.salesA.password, 's3cretpass-X');
  assert.equal(t.salesA.role, 'sales');
  assert.throws(() => accounts.parseAccounts('boss|only|three|fields'), (e) => !/fields|three/.test(e.message.replace(/Malformed accounts line #\d+ \(need role, name, email, password, user_id\)/, '')));
});

test('browser selection never needs playwright install', () => {
  assert.equal(target.resolveBrowserExecutable({}, '/bundled/chromium', (p) => p === '/bundled/chromium'), undefined);
  assert.equal(target.resolveBrowserExecutable({ E2E_CHROME_PATH: '/x/chrome' }, null, () => true), '/x/chrome');
  assert.throws(() => target.resolveBrowserExecutable({}, null, () => false), /playwright install/);
});

test('every @bug-<id> tag used by a spec is in the catalogue and has an owner stream', () => {
  const specs = fs.readdirSync(path.join(root, 'specs')).filter((f) => f.endsWith('.regression.ts'));
  assert.ok(specs.length >= 6);
  const used = new Set();
  for (const f of specs) {
    const text = fs.readFileSync(path.join(root, 'specs', f), 'utf8');
    for (const m of text.matchAll(/@bug-([0-9a-zA-Z]+(?:-[0-9a-zA-Z]+)?)/g)) used.add(m[1]);
  }
  assert.ok(used.size > 20);
  for (const id of used) {
    assert.ok(bugs.BUGS[id], `bug ${id} missing from BUGS`);
    assert.notEqual(bugs.streamOf(id), '未归属', `bug ${id} has no stream`);
  }
});

test('report groups failures by stream, flags unknown failures and database-batch items', () => {
  const mk = (title, status, tags, error = '') => ({
    title, tags: [], tests: [{ status: status === 'passed' ? 'expected' : 'unexpected', annotations: [], results: [{ status, duration: 10, errors: error ? [{ message: error }] : [], attachments: [] }] }],
    file: 'a.regression.ts', specs: undefined, _tags: tags,
  });
  const spec = (title, status, tags, error) => ({ title, file: 'a.regression.ts', tags, tests: [{ status: status === 'passed' ? 'expected' : 'unexpected', annotations: [], results: [{ status, duration: 10, error: error ? { message: error } : undefined, attachments: [] }] }] });
  const rep = { suites: [{ title: 'a.regression.ts', file: 'a.regression.ts', specs: [
    spec('operator lost', 'failed', ['role-operator', 'bug-4a-1'], 'Forbidden'),
    spec('new regression', 'failed', ['role-boss'], 'boom'),
    spec('ok', 'passed', ['role-boss', 'bug-4b-1']),
  ] }] };
  const { markdown, unknownFails, knownBugFails } = report.renderMarkdown(rep, { meta: { baseURL: 'http://x' } });
  assert.equal(unknownFails.length, 1);
  assert.equal(knownBugFails.length, 1);
  assert.match(markdown, /### S2/);
  assert.match(markdown, /待数据库批/);
  assert.match(markdown, /没有已知编号的失败/);
  assert.match(markdown, /invalid_origin/);
  void mk;
});
