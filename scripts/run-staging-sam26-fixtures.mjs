import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertCounts,
  fixtureCounts,
  openStagingClients,
  provisionFixtureIdentities,
  runFixtureSql,
} from './lib/staging-sam26-fixture-identity.mjs';

const seedPath = fileURLToPath(new URL('./seed-staging-sam26-fixtures.sql', import.meta.url));
const expectedCounts = { leads: 6, activities: 2, tasks: 2, business_events: 2, notifications: 6 };

async function main() {
  const { admin, psqlEnv } = await openStagingClients();
  await provisionFixtureIdentities(admin);

  // The first pass proves the seed runs after the auth/profile trigger path.
  runFixtureSql(psqlEnv, seedPath);
  assertCounts(await fixtureCounts(admin), expectedCounts);

  // The second pass proves fixed UUIDs are idempotent rather than additive.
  runFixtureSql(psqlEnv, seedPath);
  assertCounts(await fixtureCounts(admin), expectedCounts);

  console.log('SAM-26 staging fixture provision-and-seed completed with verified non-PII counts.');
}

main().catch((error) => {
  if (error instanceof Error && error.message.startsWith('SAM26_FAIL_CLOSED:')) {
    console.error(error.message);
  } else {
    console.error('SAM-26 staging fixture runner failed without logging credentials or user data.');
  }
  process.exitCode = 1;
});