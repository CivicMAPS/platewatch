// Fails when a required environment variable is missing, so a test cannot pass by skipping.
for (const name of process.argv.slice(2)) {
  if (!process.env[name]) {
    console.error(`${name} is required (see docs/BACKEND.md, Testing).`);
    process.exit(1);
  }
}
