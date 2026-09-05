// Tests share the project's .env (see vitest.config.ts) rather than mocking
// out infrastructure, but a *cloud* storage provider is one dependency they
// must never inherit from it: dotenv.config() (config/env.ts) never
// overrides a variable that's already set, so setting it here — before any
// test file imports config/env.ts — pins the suite to local disk no matter
// what STORAGE_PROVIDER is set to for the running dev/prod server. Without
// this, switching STORAGE_PROVIDER=cloudinary in .env would make every test
// run write real files to the Cloudinary account and fail the assertions in
// media.test.ts that check the local filesystem.
process.env.STORAGE_PROVIDER = "local";
