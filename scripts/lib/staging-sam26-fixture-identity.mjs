import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

export const STAGING_PROJECT_REF = 'bfsiibofuzoglziltgyd';
export const FIXTURE_SCOPE = 'staging-sam26';
export const FIXTURE_KIND = 'role-test';
export const REQUIRED_ROLES = ['boss', 'admin', 'operator', 'sales', 'finance', 'designer'];

const fixtureIds = {
  leads: [
    '8a260001-2c66-4d00-8000-000000000001', '8a260001-2c66-4d00-8000-000000000002',
    '8a260001-2c66-4d00-8000-000000000003', '8a260001-2c66-4d00-8000-000000000004',
    '8a260001-2c66-4d00-8000-000000000005', '8a260001-2c66-4d00-8000-000000000006',
  ],
  activities: ['8a260101-2c66-4d00-8000-000000000001', '8a260101-2c66-4d00-8000-000000000002'],
  tasks: ['8a260201-2c66-4d00-8000-000000000001', '8a260201-2c66-4d00-8000-000000000002'],
  business_events: ['8a260301-2c66-4d00-8000-000000000001', '8a260301-2c66-4d00-8000-000000000002'],
  notifications: [
    '8a260401-2c66-4d00-8000-000000000001', '8a260401-2c66-4d00-8000-000000000002',
    '8a260401-2c66-4d00-8000-000000000003', '8a260401-2c66-4d00-8000-000000000004',
    '8a260401-2c66-4d00-8000-000000000005', '8a260401-2c66-4d00-8000-000000000006',
  ],
};

export function fail(message) {
  throw new Error(`SAM26_FAIL_CLOSED: ${message}`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`missing required environment variable ${name}`);
  return value;
}

function assertProjectTarget() {
  for (const name of ['NEWME_STAGING_PROJECT_REF', 'SUPABASE_PROJECT_REF']) {
    if (process.env[name] !== STAGING_PROJECT_REF) fail(`${name} does not match the approved staging project`);
  }
  const apiUrl = new URL(requireEnv('NEXT_PUBLIC_SUPABASE_URL'));
  if (apiUrl.hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
    fail('NEXT_PUBLIC_SUPABASE_URL does not resolve to the approved staging project');
  }
  return apiUrl.toString();
}

export async function openStagingClients() {
  const apiUrl = assertProjectTarget();
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const databasePassword = requireEnv('SUPABASE_DB_PASSWORD');
  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const psqlEnv = {
    ...process.env,
    PGHOST: `db.${STAGING_PROJECT_REF}.supabase.co`,
    PGPORT: '5432',
    PGUSER: 'postgres',
    PGDATABASE: 'postgres',
    PGPASSWORD: databasePassword,
    PGSSLMODE: 'require',
    PGOPTIONS: `-c app.newme.staging_fixture_target=${STAGING_PROJECT_REF}`,
  };
  return { admin, psqlEnv };
}

export function fixtureMetadata(role) {
  return { fixture_scope: FIXTURE_SCOPE, fixture_kind: FIXTURE_KIND, role };
}

function hasExactFixtureMarker(user, role) {
  const metadata = user.app_metadata ?? {};
  return metadata.fixture_scope === FIXTURE_SCOPE
    && metadata.fixture_kind === FIXTURE_KIND
    && metadata.role === role;
}

async function listAllUsers(admin) {
  const users = [];
  for (let page = 1; page < 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail('Admin API listUsers failed');
    users.push(...(data.users ?? []));
    if ((data.users ?? []).length < 200) return users;
  }
  fail('Admin API user pagination exceeded the safe ceiling');
}

export async function listFixtureUsers(admin) {
  const allUsers = await listAllUsers(admin);
  const scoped = allUsers.filter((user) => user.app_metadata?.fixture_scope === FIXTURE_SCOPE);
  const fixtures = scoped.filter((user) => user.app_metadata?.fixture_kind === FIXTURE_KIND);
  if (scoped.length !== fixtures.length) fail('found a staging-sam26 identity with an unexpected fixture kind');

  const byRole = new Map();
  for (const user of fixtures) {
    const role = user.app_metadata?.role;
    if (!REQUIRED_ROLES.includes(role)) fail('found a staging-sam26 identity with an unexpected role');
    if (!hasExactFixtureMarker(user, role) || byRole.has(role)) fail('fixture identity marker is incomplete or duplicated');
    byRole.set(role, user);
  }
  return byRole;
}

function expectedProfileName(role) {
  return `[SAM-26] Synthetic ${role}`;
}

function expectedEmail(role, email) {
  return email === `sam26.${role}.fixture@invalid.test`;
}

async function loadFixtureProfile(admin, user, role) {
  if (!hasExactFixtureMarker(user, role)) fail('refusing a profile operation without an exact Admin API fixture marker');
  const { data, error } = await admin
    .from('profiles')
    .select('id, role, full_name, email, is_active, force_password_change')
    .eq('id', user.id)
    .maybeSingle();
  if (error || !data) fail('auth-user creation did not produce a profile through the expected trigger');
  return data;
}

export async function provisionFixtureIdentities(admin) {
  const existing = await listFixtureUsers(admin);
  const fixtureUsers = [];
  for (const role of REQUIRED_ROLES) {
    const known = existing.get(role);
    if (known) {
      const profile = await loadFixtureProfile(admin, known, role);
      if (profile.role !== role || profile.full_name !== expectedProfileName(role) || !expectedEmail(role, profile.email) || profile.is_active !== true) {
        fail('existing fixture identity does not match its exact profile marker');
      }
      fixtureUsers.push(known);
      continue;
    }

    const { data, error } = await admin.auth.admin.createUser({
      email: `sam26.${role}.fixture@invalid.test`,
      password: randomBytes(32).toString('base64url'),
      email_confirm: true,
      app_metadata: fixtureMetadata(role),
      user_metadata: { full_name: expectedProfileName(role) },
    });
    if (error || !data.user || !hasExactFixtureMarker(data.user, role)) fail('Admin API createUser did not return an exact fixture marker');

    const { data: refreshed, error: refreshError } = await admin.auth.admin.updateUserById(data.user.id, {
      app_metadata: fixtureMetadata(role),
    });
    if (refreshError || !refreshed.user || !hasExactFixtureMarker(refreshed.user, role)) fail('Admin API updateUserById did not preserve the exact fixture marker');

    const profile = await loadFixtureProfile(admin, refreshed.user, role);
    const { error: profileError } = await admin
      .from('profiles')
      .update({ role, full_name: expectedProfileName(role), email: `sam26.${role}.fixture@invalid.test`, is_active: true, force_password_change: true })
      .eq('id', profile.id);
    if (profileError) fail('failed to configure the profile created by the auth trigger');

    const verified = await loadFixtureProfile(admin, refreshed.user, role);
    if (verified.role !== role || verified.full_name !== expectedProfileName(role) || !expectedEmail(role, verified.email) || verified.is_active !== true || verified.force_password_change !== true) {
      fail('profile-trigger verification failed after configuring a fixture identity');
    }
    fixtureUsers.push(refreshed.user);
  }
  if ((await listFixtureUsers(admin)).size !== REQUIRED_ROLES.length) fail('fixture identity set is incomplete after provisioning');
  return fixtureUsers;
}

export function runFixtureSql(psqlEnv, scriptPath) {
  if (!existsSync(scriptPath)) fail('required marker-guarded fixture SQL file is absent');
  const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', scriptPath], {
    env: psqlEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) fail('psql fixture script failed');
}

async function countKnownFixtureIds(admin, table, ids) {
  const { count, error } = await admin.from(table).select('id', { count: 'exact', head: true }).in('id', ids);
  if (error || count === null) fail(`service-role count failed for ${table}`);
  return count;
}

export async function fixtureCounts(admin) {
  const entries = await Promise.all(Object.entries(fixtureIds).map(async ([table, ids]) => [table, await countKnownFixtureIds(admin, table, ids)]));
  return Object.fromEntries(entries);
}

export function assertCounts(counts, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (counts[key] !== value) fail(`fixture count verification failed for ${key}`);
  }
}

export async function assertFixtureProfilesDeleted(admin, ids) {
  const { count, error } = await admin.from('profiles').select('id', { count: 'exact', head: true }).in('id', ids);
  if (error || count !== 0) fail('fixture profiles remain after marked auth cleanup');
}

export async function deleteFixtureIdentities(admin) {
  const fixtures = await listFixtureUsers(admin);
  if (fixtures.size !== REQUIRED_ROLES.length) fail('cleanup requires the exact six-role fixture identity set');
  for (const role of REQUIRED_ROLES) {
    const user = fixtures.get(role);
    if (!user || !hasExactFixtureMarker(user, role)) fail('refusing Admin API deleteUser without an exact fixture marker');
    const { error } = await admin.auth.admin.deleteUser(user.id, false);
    if (error) fail('Admin API deleteUser failed for a marked fixture identity');
  }
  if ((await listFixtureUsers(admin)).size !== 0) fail('fixture identities remain after cleanup');
}
