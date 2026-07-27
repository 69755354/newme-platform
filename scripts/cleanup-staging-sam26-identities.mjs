import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertCounts,
  assertFixtureProfilesDeleted,
  deleteFixtureIdentities,
  fixtureCounts,
  listFixtureUsers,
  openStagingClients,
  runFixtureSql,
} from './lib/staging-sam26-fixture-identity.mjs';

const cleanupPath = fileURLToPath(new URL('./cleanup-staging-sam26-fixtures.sql', import.meta.url));
const zeroCounts = { leads: 0, activities: 0, tasks: 0, business_events: 0, notifications: 0 };

async function main() {
  const { admin, database } = await openStagingClients();
  try {
    const fixtures = await listFixtureUsers(admin);
    const identityIds = [...fixtures.values()].map((user) => user.id);

    // Identity cleanup is prohibited until the independently marker-guarded
    // core-fixture cleanup has completed and its counts are exactly zero.
    await runFixtureSql(database, cleanupPath);
    assertCounts(await fixtureCounts(database), zeroCounts);
    await assertFixtureProfilesDeleted(database, identityIds);
    await deleteFixtureIdentities(admin);

    console.log('SAM-26 staging fixture cleanup completed with verified zero counts.');
  } finally {
    await database.end();
  }
}

main().catch((error) => {
  if (error instanceof Error && error.message.startsWith('SAM26_FAIL_CLOSED:')) {
    console.error(error.message);
  } else {
    console.error('SAM-26 staging fixture cleanup failed without logging credentials or user data.');
  }
  process.exitCode = 1;
});
