// Tests share the project's .env (see vitest.config.ts) rather than mocking
// out infrastructure, but a *cloud* storage provider is one dependency they
// must never inherit from it: dotenv.config() (config/env.ts) never
// overrides a variable that's already set, so setting it here — before any
// test file imports config/env.ts — pins the suite to local disk no matter
// what STORAGE_PROVIDER is set to for the running dev/prod server. Without
// this, switching STORAGE_PROVIDER=r2 in .env would make every test
// run write real files to the R2 bucket and fail the assertions in
// media.test.ts that check the local filesystem.
process.env.STORAGE_PROVIDER = "local";

// Same idea for email: the tests share .env, whose SMTP_* would send REAL mail
// (e.g. inquiry confirmations to fake addresses) through the developer's mailbox.
// Blank SMTP makes sendEmail a logged no-op; tests that assert on email mock
// the email service instead.
process.env.SMTP_HOST = "";
