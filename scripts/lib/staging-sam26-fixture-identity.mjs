import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

export const STAGING_PROJECT_REF = 'bfsiibofuzoglziltgyd';
export const FIXTURE_SCOPE = 'staging-sam26';
export const FIXTURE_KIND = 'role-test';
export const REQUIRED_ROLES = ['boss', 'admin', 'operator', 'sales', 'finance', 'designer'];

const fixtureLeadIds = [
  '8a260001-2c66-4d00-8000-000000000001',
  '8a260001-2c66-4d00-8000-000000000002',
  '8a260001-2c66-4d00-8000-000000000003',
  '8a260001-2c66-4d00-8000-000000000004',
  '8a260001-2c66-4d00-8000-000000000005',
  '8a260001-2c66-4d00-8000-000000000006',
];
const fixtureActivityIds = [
  '8a260101-2c66-4d00-8000-000000000001',
  '8a260101-2c66-4d00-8000-000000000002',
];
const fixtureTaskIds = [
  '8a260201-2c66-4d00-8000-000000000001',
  '8a260201-2c66-4d00-8000-000000000002',
];
const fixtureEventIds = [
  '8a260301-2c66-4d00-8000-000000000001',
  '8a260301-2c66-4d00-8000-000000000002',
];
const fixtureNotificationIds = [
  '8a260401-2c66-4d00-8000-000000000001',
  '8a260401-2c66-4d00-8000-000000000002',
  '8a260401-2c66-4d00-8000-000000000003',
  '8a260401-2c66-4d00-8000-000000000004',
  '8a260401-2c66-4d00-8000-000000000005',
  '8a260401-2c66-4d00-8000-000000000006',
];

export function fail(message) {
  throw new Error(`SAM26_FAIL_CLOSED: ${message}`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`missing required environment variable ${name}`);
  return value;
}

function assertProjectTarget() {
  if (process.env.NEWME_STAGING_SUPABASE_REF !== STAGING_PROJECT_REF) {
    fail('NEWME_STAGING_SUPABASE_REF does not match the approved staging project');
  }

  const apiUrl = new URL(requireEnv('NEXT_PUBLIC_SUPABASE_URL'));
  if (apiUrl.hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
    fail('NEXT_PUBLIC_SUPABASE_URL does not resolve to the approved staging project');
  }

  const databaseUrl = new URL(requireEnv('STAGING_DATABASE_URL'));
  if (databaseUrl.hostname !== `db.${STAGING_PROJECT_REF}.supabase.co`) {
    fail('STAGING_DATABASE_URL does not resolve to the approved staging project');
  }

  return { apiUrl: apiUrl.toString(), databaseUrl: databaseUrl.toString() };
}

export async function openStagingClients() {
  const { apiUrl, databaseUrl } = assertProjectTarget();
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const { Client } = await import('pg');
  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const database = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: true } });
  await database.connect();
  return { admin, database };
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
    if (!hasExactFixtureMarker(user, role)) fail('fixture identity marker is incomplete');
    if (byRole.has(role)) fail('found duplicate staging-sam26 fixture identities for a role');
    byRole.set(role, user);
  }
  return byRole;
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

function expectedProfileName(role) {
  return `[SAM-26] Synthetic ${role}`;
}

function expectedEmail(role, email) {
  return email === `sam26.${role}.fixture@invalid.test`;
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

    const password = randomBytes(32).toString('base64url');
    const email = `sam26.${role}.fixture@invalid.test`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: fixtureMetadata(role),
      user_metadata: { full_name: expectedProfileName(role) },
    });
    if (error || !data.user || !hasExactFixtureMarker(data.user, role)) {
      fail('Admin API createUser did not return an exact fixture marker');
    }

    const { data: refreshed, error: refreshError } = await admin.auth.admin.updateUserById(data.user.id, {
      app_metadata: fixtureMetadata(role),
    });
    if (refreshError || !refreshed.user || !hasExactFixtureMarker(refreshed.user, role)) {
      fail('Admin API updateUserById did not preserve the exact fixture marker');
    }

    const profile = await loadFixtureProfile(admin, refreshed.user, role);
    const { error: profileError } = await admin
      .from('profiles')
      .update({
        role,
        full_name: expectedProfileName(role),
        email,
        is_active: true,
        force_password_change: true,
      })
      .eq('id', profile.id);
    if (profileError) fail('failed to configure the profile created by the auth trigger');

    const verifiedProfile = await loadFixtureProfile(admin, refreshed.user, role);
    if (verifiedProfile.role !== role || verifiedProfile.full_name !== expectedProfileName(role) || !expectedEmail(role, verifiedProfile.email) || verifiedProfile.is_active !== true || verifiedProfile.force_password_change !== true) {
      fail('profile-trigger verification failed after configuring a fixture identity');
    }
    fixtureUsers.push(refreshed.user);
  }

  const finalUsers = await listFixtureUsers(admin);
  if (finalUsers.size !== REQUIRED_ROLES.length) fail('fixture identity set is incomplete after provisioning');
  return fixtureUsers;
}

export async function runFixtureSql(database, scriptPath) {
  const sql = readFileSync(scriptPath, 'utf8').replace(/^\\set[^\r\n]*\r?\n/m, '');
  await database.query("select set_config('app.newme.staging_fixture_target', $1, false)", [STAGING_PROJECT_REF]);
  await database.query(sql);
}

export async function fixtureCounts(database) {
  const { rows } = await database.query(`
    select
      (select count(*)::int from public.leads where id = any($1::uuid[]) and metadata ->> 'fixture_scope' = $6) as leads,
      (select count(*)::int from public.activities where id = any($2::uuid[]) and metadata ->> 'fixture_scope' = $6) as activities,
      (select count(*)::int from public.tasks where id = any($3::uuid[]) and description like 'fixture_scope=staging-sam26;%') as tasks,
      (select count(*)::int from public.business_events where id = any($4::uuid[]) and event_data ->> 'fixture_scope' = $6) as business_events,
      (select count(*)::int from public.notifications where id = any($5::uuid[]) and title = '[SAM-26] synthetic lead assignment') as notifications
  `, [fixtureLeadIds, fixtureActivityIds, fixtureTaskIds, fixtureEventIds, fixtureNotificationIds, FIXTURE_SCOPE]);
  return rows[0];
}

export function assertCounts(counts, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (counts[key] !== value) fail(`fixture count verification failed for ${key}`);
  }
}

export async function assertFixtureProfilesDeleted(database, ids) {
  const fkResult = await database.query(`
    select kcu.table_schema, kcu.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and ccu.table_schema = 'public'
      and ccu.table_name = 'profiles'
      and kcu.table_schema = 'public'
    order by kcu.table_name, kcu.column_name
  `);

  for (const reference of fkResult.rows) {
    const identifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
    const query = `select count(*)::int as count from ${identifier(reference.table_schema)}.${identifier(reference.table_name)} where ${identifier(reference.column_name)} = any($1::uuid[])`;
    const { rows } = await database.query(query, [ids]);
    if (rows[0].count !== 0) fail('fixture identities still have public foreign-key references');
  }
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
