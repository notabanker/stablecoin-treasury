const { validateProductionConfig } = await import("../packages/shared/config.mjs");

// Only check if the operator has explicitly opted into production mode.
// This script is safe to include in `npm run check` for local dev.
if (process.env.PRODUCTION_MODE !== "true") {
  console.log("Production mode not enabled. Skipping production config check.");
  process.exit(0);
}

const services = [
  "api-gateway", "wallet-service", "policy-service", "compliance-service",
  "payment-service", "accounting-service", "reconciliation-service",
  "operations-service", "relay-worker", "job-worker"
];

let failing = 0;

for (const svc of services) {
  try {
    validateProductionConfig(svc);
  } catch (error) {
    failing++;
    console.log(error.message);
  }
}

if (failing > 0) {
  console.log(`\n${failing} service(s) have invalid production config.`);
  process.exit(1);
}

console.log("All production config checks passed.");
