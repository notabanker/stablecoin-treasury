// CLI tool for listing and retrying stuck payments.
// Usage: node scripts/repair.mjs [list|retry <paymentId>]

const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8080/api";

async function req(path, method = "GET") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" }
  });
  const data = await response.json();
  return { status: response.status, data };
}

const action = process.argv[2] || "list";
const paymentId = process.argv[3];

if (action === "list") {
  const result = await req("/repair");
  console.log(JSON.stringify(result.data, null, 2));
} else if (action === "retry" && paymentId) {
  const result = await req(`/repair/${paymentId}/retry`, "POST");
  console.log(JSON.stringify(result.data, null, 2));
} else if (action === "attempts" && paymentId) {
  const result = await req(`/payments/${paymentId}/attempts`);
  console.log(JSON.stringify(result.data, null, 2));
} else {
  console.log("Usage: node scripts/repair.mjs [list|retry <paymentId>|attempts <paymentId>]");
  process.exit(1);
}
