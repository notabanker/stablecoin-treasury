// Canonical service topology, defined once for every consumer: the dev stack, the test
// harness, and the service client. Order defines the test-harness port offsets (gateway
// first at the base port).
export const SERVICES = [
  { name: "gateway", path: "services/api-gateway/src/index.mjs", env: "GATEWAY_PORT", port: 8080, role: "svc_gateway" },
  { name: "wallet", path: "services/wallet-service/src/index.mjs", env: "PORT", port: 4101, role: "svc_wallet", urlEnv: "WALLET_SERVICE_URL" },
  { name: "policy", path: "services/policy-service/src/index.mjs", env: "PORT", port: 4102, role: "svc_policy", urlEnv: "POLICY_SERVICE_URL" },
  { name: "compliance", path: "services/compliance-service/src/index.mjs", env: "PORT", port: 4103, role: "svc_compliance", urlEnv: "COMPLIANCE_SERVICE_URL" },
  { name: "payment", path: "services/payment-service/src/index.mjs", env: "PORT", port: 4104, role: "svc_payment", urlEnv: "PAYMENT_SERVICE_URL" },
  { name: "accounting", path: "services/accounting-service/src/index.mjs", env: "PORT", port: 4105, role: "svc_accounting", urlEnv: "ACCOUNTING_SERVICE_URL" },
  { name: "reconciliation", path: "services/reconciliation-service/src/index.mjs", env: "PORT", port: 4106, role: "svc_reconciliation", urlEnv: "RECONCILIATION_SERVICE_URL" },
  { name: "operations", path: "services/operations-service/src/index.mjs", env: "PORT", port: 4107, role: "svc_operations", urlEnv: "OPERATIONS_SERVICE_URL" },
  { name: "relay", path: "services/relay-worker/src/index.mjs", env: "PORT", port: 9101, role: "svc_relay" },
  { name: "job", path: "services/job-worker/src/index.mjs", env: "PORT", port: 9102, role: "svc_job" }
];

// The domain services the gateway talks to over HTTP (everything except the gateway itself).
export const DOMAIN_SERVICES = SERVICES.filter((service) => service.urlEnv);

export function serviceUrl(service) {
  return process.env[service.urlEnv] || `http://127.0.0.1:${service.port}`;
}
