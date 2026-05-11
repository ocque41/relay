/**
 * Inserts a fake Neon account + API key directly (bypasses the Neon Management API)
 * to validate the encrypt/decrypt cycle and API routes end-to-end.
 */
import { eq } from 'drizzle-orm';
import { db } from '../src/server/db/index';
import { accounts, api_keys, signup_jobs } from '../src/server/db/schema';
import { encrypt } from '../src/server/crypto';

const fakeConnectionUri =
  'postgresql://testuser:testpassword@ep-test-123.us-east-2.aws.neon.tech/testdb?sslmode=require';

async function main() {
  const signupId = crypto.randomUUID();
  const accountId = crypto.randomUUID();

  await db.insert(signup_jobs).values({ id: signupId, status: 'complete' });

  await db.insert(accounts).values({
    id: accountId,
    provider_id: 'neon',
    external_id: 'test-project-123',
    label: 'test-account',
    email_alias: `signup-${signupId}@mail.example.com`,
    credentials_enc: encrypt(fakeConnectionUri),
  });

  await db.insert(api_keys).values({
    account_id: accountId,
    label: 'initial',
    key_enc: encrypt(fakeConnectionUri),
  });

  await db
    .update(signup_jobs)
    .set({ account_id: accountId })
    .where(eq(signup_jobs.id, signupId));

  console.log(JSON.stringify({ signupId, accountId }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
