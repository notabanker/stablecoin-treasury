export const appEl = document.querySelector("#app");
export const toastEl = document.querySelector("#toast-root");

export const state = {
  activeView: "overview",
  busy: "",
  data: null,
  error: "",
  filters: {
    paymentSearch: "",
    paymentStatus: "All"
  },
  refreshFailedAt: null,
  needsLogin: false,
  selectedPaymentId: "",
  paymentApprovals: {},
  sessionToken: "",
  showPaymentForm: false,
  toast: null
};

export const views = [
  ["overview", "Overview"],
  ["payments", "Payments"],
  ["wallets", "Wallets"],
  ["controls", "Controls"],
  ["repair", "Repair"],
  ["reconciliation", "Reconciliation"],
  ["operations", "Operations"]
];

export const FETCH_TIMEOUT_MS = 10000;

export const statusClasses = {
  Approved: "status-approved",
  Blocked: "status-blocked",
  Cancelled: "status-muted",
  Clear: "status-clear",
  Degraded: "status-warning",
  Executing: "status-warning",
  Exported: "status-clear",
  Failed: "status-blocked",
  High: "status-blocked",
  Low: "status-clear",
  Medium: "status-warning",
  Open: "status-warning",
  Operational: "status-clear",
  "Pending approval": "status-pending",
  Ready: "status-ready",
  Resolved: "status-clear",
  Review: "status-warning",
  Settled: "status-clear",
  error: "status-blocked",
  started: "status-warning",
  success: "status-clear"
};
