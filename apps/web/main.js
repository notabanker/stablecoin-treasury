const appEl = document.querySelector("#app");
const toastEl = document.querySelector("#toast-root");

const state = {
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
  sessionToken: "",
  showPaymentForm: false,
  toast: null
};

const views = [
  ["overview", "Overview"],
  ["payments", "Payments"],
  ["wallets", "Wallets"],
  ["controls", "Controls"],
  ["repair", "Repair"],
  ["reconciliation", "Reconciliation"],
  ["operations", "Operations"]
];

const FETCH_TIMEOUT_MS = 10000;

const statusClasses = {
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
  Settled: "status-clear"
  ,
  error: "status-blocked",
  started: "status-warning",
  success: "status-clear"
};

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  loadState();
});

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    const id = target.dataset.id || "";

    if (action === "navigate") {
      state.activeView = id;
      state.showPaymentForm = false;
      render();
      return;
    }

    if (action === "refresh") {
      await loadState("Refreshing desk");
      return;
    }

    if (action === "logout") {
      await logout();
      return;
    }

    if (action === "new-payment") {
      state.showPaymentForm = true;
      state.activeView = "payments";
      render();
      return;
    }

    if (action === "close-payment-form") {
      state.showPaymentForm = false;
      render();
      return;
    }

    if (action === "select-payment") {
      state.selectedPaymentId = id;
      state.activeView = "payments";
      render();
      return;
    }

    const mutations = {
      "approve-payment": () => post(`/payments/${id}/approve`, {}, "Payment approved"),
      "cancel-payment": () => post(`/payments/${id}/cancel`, {}, "Payment cancelled"),
      "execute-payment": () => post(`/payments/${id}/execute`, {}, "Payment executed"),
      "retry-execution": () => post(`/repair/${id}/retry`, {}, "Execution retried"),
      "resolve-recon": () => post(`/reconciliation/${id}/resolve`, {}, "Exception resolved"),
      "simulate-recon": () => post("/reconciliation/exceptions/simulate", {}, "Exception created"),
      "export-accounting": () => post("/accounting/export", {}, "Journal batch exported"),
      "toggle-provider": () => post(`/operations/providers/${id}/toggle`, {}, "Provider status updated"),
      "simulate-incident": () => post("/operations/incidents/simulate", {}, "Incident opened")
    };

    if (action === "toggle-asset") {
      const enabled = target.dataset.enabled === "true";
      await post(`/policies/assets/${id}`, { enabled: !enabled }, "Asset policy updated");
      return;
    }

    if (mutations[action]) {
      await mutations[action]();
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!form.matches("[data-form]")) return;
    event.preventDefault();

    if (form.dataset.form === "login") {
      const formData = new FormData(form);
      await login(String(formData.get("email") || ""), String(formData.get("password") || ""));
      return;
    }

    if (form.dataset.form === "create-payment") {
      const formData = new FormData(form);
      await post(
        "/payments",
        {
          amount: Number(formData.get("amount")),
          counterpartyId: String(formData.get("counterpartyId")),
          memo: String(formData.get("memo") || ""),
          sourceWalletId: String(formData.get("sourceWalletId")),
          type: String(formData.get("type") || "Supplier")
        },
        "Payment created",
        { "Idempotency-Key": createIdempotencyKey() }
      );
      state.showPaymentForm = false;
      return;
    }

    if (form.dataset.form === "policy") {
      const formData = new FormData(form);
      await post(
        "/policies",
        {
          approvalThreshold: Number(formData.get("approvalThreshold")),
          concentrationLimit: Number(formData.get("concentrationLimit")),
          hardTransferLimit: Number(formData.get("hardTransferLimit")),
          secondApprovalThreshold: Number(formData.get("secondApprovalThreshold"))
        },
        "Policy thresholds saved"
      );
      return;
    }

    if (form.dataset.form === "payment-filter") {
      const formData = new FormData(form);
      state.filters.paymentSearch = String(formData.get("paymentSearch") || "").trim();
      state.filters.paymentStatus = String(formData.get("paymentStatus") || "All");
      render();
    }
  });
}

async function loadState(label = "Loading desk") {
  state.busy = label;
  if (!state.data) {
    state.error = "";
  }
  render();
  try {
    const data = await request("/state");
    receiveState(data);
  } catch (error) {
    if (error.status === 401) {
      state.data = null;
      state.error = "";
      state.needsLogin = true;
      return;
    }
    if (state.data) {
      // Data already on screen -- a failed refresh must not silently leave a stale-looking
      // dashboard. Surface it as a banner (persists until the next successful refresh) and a
      // toast (transient), rather than only setting state.error, which nothing rendered while
      // state.data was truthy.
      state.refreshFailedAt = new Date().toISOString();
      showToast(`Refresh failed: ${readableError(error)}`, "error");
    } else {
      state.error = readableError(error);
    }
  } finally {
    state.busy = "";
    render();
  }
}

async function login(email, password) {
  state.busy = "Signing in";
  state.error = "";
  render();
  try {
    const result = await request("/login", {
      body: JSON.stringify({ email, password }),
      method: "POST"
    }, { skipAuth: true });
    // Session is now stored in an HttpOnly cookie set by the server.
    // The response body includes the session info for display purposes.
    state.sessionToken = result.session.token || "cookie-managed";
    state.needsLogin = false;
    showToast("Signed in", "success");
    await loadState("Loading desk");
  } catch (error) {
    state.needsLogin = true;
    state.error = readableError(error);
  } finally {
    state.busy = "";
    render();
  }
}

async function logout() {
  state.busy = "Signing out";
  render();
  try {
    if (state.sessionToken) {
      await request("/logout", { method: "POST", body: "{}" });
    }
  } catch {
    // Local logout must still clear the browser session if the server token has expired.
  } finally {
    state.sessionToken = "";
    state.needsLogin = false;
    state.data = null;
    state.needsLogin = true;
    state.busy = "";
    render();
  }
}

async function post(path, body, successMessage, headers = {}) {
  state.busy = successMessage;
  render();
  try {
    const result = await request(path, {
      body: JSON.stringify(body),
      headers,
      method: "POST"
    });
    if (result.state) {
      receiveState(result.state);
    }
    showToast(successMessage, "success");
  } catch (error) {
    showToast(readableError(error), "error");
  } finally {
    state.busy = "";
    render();
  }
}

async function request(path, options = {}, controls = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // CSRF double-submit: read the token from the readable csrf cookie and send it as a header.
  const csrfToken = document.cookie.split("; ").find((c) => c.startsWith("__Host-csrf=") || c.startsWith("csrf="))?.split("=")[1] || "";
  const isMutation = options.method && options.method !== "GET" && options.method !== "HEAD";
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        // Session token is now in an HttpOnly cookie (auto-sent by the browser).
        // CSRF token is sent as a header for mutating requests.
        ...(isMutation && csrfToken ? { "X-Csrf-Token": csrfToken } : {}),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request to ${path} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.message || payload?.error || `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload?.error;
    throw error;
  }
  return payload;
}

function receiveState(data) {
  state.data = data;
  state.error = "";
  state.needsLogin = false;
  state.refreshFailedAt = null;
  state.selectedPaymentId = state.selectedPaymentId || data.selectedPaymentId || data.payments?.[0]?.id || "";
}

function render() {
  if (state.needsLogin) {
    appEl.innerHTML = renderLogin();
    renderToast();
    return;
  }

  if (!state.data && !state.error) {
    appEl.innerHTML = renderBoot();
    renderToast();
    return;
  }

  if (state.error && !state.data) {
    appEl.innerHTML = renderServiceError();
    renderToast();
    return;
  }

  appEl.innerHTML = `
    <aside class="sidebar">
      <div class="brand-block">
        <div class="brand-mark">VT</div>
        <div>
          <div class="brand-title">Vega Treasury</div>
          <div class="brand-subtitle">Stablecoin Control</div>
        </div>
      </div>
      <nav class="nav-list" aria-label="Main navigation">
        ${views.map(([id, label]) => renderNavItem(id, label)).join("")}
      </nav>
      ${renderSidebarStatus()}
    </aside>
    <section class="workspace">
      ${renderTopbar()}
      <main class="content-area">
        ${renderActiveView()}
      </main>
    </section>
  `;
  renderToast();
}

function renderLogin() {
  return `
    <main class="login-shell">
      <section class="login-panel">
        <div class="brand-block login-brand">
          <div class="brand-mark">VT</div>
          <div>
            <div class="brand-title">Vega Treasury</div>
            <div class="brand-subtitle">Stablecoin Control</div>
          </div>
        </div>
        <form class="login-form" data-form="login">
          <label>
            <span>Email</span>
            <input name="email" type="email" autocomplete="username" required value="marta@vega-industries.com">
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" autocomplete="current-password" required>
          </label>
          ${state.error ? `<div class="login-error" role="alert">${escapeHtml(state.error)}</div>` : ""}
          <button class="btn primary" type="submit" ${state.busy ? "disabled" : ""}>Sign in</button>
        </form>
      </section>
    </main>
  `;
}

function renderBoot() {
  return `
    <main class="boot-panel">
      <div class="boot-mark">VT</div>
      <h1>Vega Treasury Control</h1>
      <p>${escapeHtml(state.busy || "Connecting to treasury services")}</p>
    </main>
  `;
}

function renderServiceError() {
  return `
    <main class="service-error">
      <section class="error-panel">
        <div class="section-kicker">Service unavailable</div>
        <h1>Gateway connection failed</h1>
        <p>${escapeHtml(state.error)}</p>
        ${button("Retry", "refresh", "", "primary")}
      </section>
    </main>
  `;
}

function renderNavItem(id, label) {
  const active = state.activeView === id ? "is-active" : "";
  return `
    <button class="nav-item ${active}" type="button" data-action="navigate" data-id="${escapeHtml(id)}">
      <span class="nav-glyph">${escapeHtml(label.slice(0, 2).toUpperCase())}</span>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function renderSidebarStatus() {
  const data = state.data;
  const openAlerts = data.alerts.filter((alert) => alert.status === "Open").length;
  const degraded = data.providers.filter((provider) => provider.status !== "Operational").length;
  return `
    <section class="sidebar-status">
      <div class="mini-label">Open alerts</div>
      <div class="mini-value">${openAlerts}</div>
      <div class="mini-row">
        <span>Provider risk</span>
        ${pill(degraded ? `${degraded} degraded` : "Clear", degraded ? "warning" : "clear")}
      </div>
    </section>
  `;
}

function renderTopbar() {
  const data = state.data;
  return `
    <header class="topbar">
      <div>
        <div class="section-kicker">Group treasury</div>
        <h1>${escapeHtml(viewTitle())}</h1>
      </div>
      <div class="topbar-actions">
        ${state.busy ? `<span class="busy-chip">${escapeHtml(state.busy)}</span>` : ""}
        <span class="timestamp">${escapeHtml(formatDateTime(data.lastUpdated))}</span>
        <span class="user-chip">${escapeHtml(data.currentUser.name)}${data.currentUser.tenantId ? `<span>${escapeHtml(shortTenant(data.currentUser.tenantId))}</span>` : ""}</span>
        ${button("Refresh", "refresh", "", "secondary")}
        ${button("New payment", "new-payment", "", "primary")}
        ${state.sessionToken ? button("Logout", "logout", "", "ghost") : ""}
      </div>
    </header>
    ${renderStaleBanner()}
  `;
}

function renderStaleBanner() {
  if (!state.refreshFailedAt) return "";
  return `
    <div class="stale-banner" role="alert">
      <span>Showing data from ${escapeHtml(formatDateTime(state.data.lastUpdated))}. The last refresh failed at ${escapeHtml(formatDateTime(state.refreshFailedAt))}.</span>
      ${button("Retry refresh", "refresh", "", "secondary")}
    </div>
  `;
}

function viewTitle() {
  return views.find(([id]) => id === state.activeView)?.[1] || "Overview";
}

function renderActiveView() {
  if (state.activeView === "payments") return renderPaymentsView();
  if (state.activeView === "wallets") return renderWalletsView();
  if (state.activeView === "controls") return renderControlsView();
  if (state.activeView === "repair") return renderRepairView();
  if (state.activeView === "reconciliation") return renderReconciliationView();
  if (state.activeView === "operations") return renderOperationsView();
  return renderOverviewView();
}

function renderOverviewView() {
  const data = state.data;
  const metrics = computeMetrics(data);
  return `
    <section class="metric-grid">
      ${metricCard("Total liquidity", money(metrics.totalEur, "EUR"), `${metrics.walletCount} wallets`)}
      ${metricCard("Pending approvals", metrics.pendingApprovals, `${metrics.blockedPayments} blocked`)}
      ${metricCard("Open exceptions", metrics.openExceptions, `${metrics.readyJournals} ready journals`)}
      ${metricCard("Provider health", `${metrics.operationalProviders}/${data.providers.length}`, `${metrics.degradedProviders} degraded`)}
      ${metricCard("Policy limit", money(data.policies.hardTransferLimit, "EUR"), "Hard transfer cap")}
    </section>

    <section class="split-grid wide-first">
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Liquidity</div>
            <h2>Wallet coverage</h2>
          </div>
          ${pill(`${Math.round(metrics.eurAssetShare * 100)}% EUR exposure`, metrics.eurAssetShare > 0.5 ? "clear" : "warning")}
        </div>
        ${renderWalletTable(data.wallets.slice(0, 6), true)}
      </div>
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Risk lane</div>
            <h2>Open work</h2>
          </div>
        </div>
        ${renderRiskLane()}
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="section-kicker">Payment rail</div>
          <h2>Recent movements</h2>
        </div>
        ${button("View payments", "navigate", "payments", "secondary")}
      </div>
      ${renderPaymentTable(data.payments.slice(0, 5), false)}
    </section>
  `;
}

function renderPaymentsView() {
  const data = state.data;
  const payments = filteredPayments();
  const selected = data.payments.find((payment) => payment.id === state.selectedPaymentId) || data.payments[0];
  return `
    ${state.showPaymentForm ? renderPaymentForm() : ""}
    <section class="panel">
      <div class="panel-header command-header">
        <div>
          <div class="section-kicker">Payment operations</div>
          <h2>Queue</h2>
        </div>
        <form class="filter-form" data-form="payment-filter">
          <input name="paymentSearch" type="search" value="${escapeHtml(state.filters.paymentSearch)}" aria-label="Search payments">
          <select name="paymentStatus" aria-label="Payment status">
            ${["All", "Pending approval", "Approved", "Executing", "Settled", "Blocked", "Cancelled", "Failed"].map((status) => option(status, state.filters.paymentStatus)).join("")}
          </select>
          <button class="btn secondary" type="submit">Filter</button>
        </form>
      </div>
      ${renderPaymentTable(payments, true)}
    </section>
    <section class="split-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Selected payment</div>
            <h2>${escapeHtml(selected?.reference || "None")}</h2>
          </div>
          ${selected ? badge(selected.status) : ""}
        </div>
        ${selected ? renderPaymentDetail(selected) : emptyState("No payment selected")}
      </div>
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Counterparties</div>
            <h2>Screening status</h2>
          </div>
        </div>
        ${renderCounterpartyTable(data.counterparties)}
      </div>
    </section>
  `;
}

function renderPaymentForm() {
  const data = state.data;
  return `
    <section class="panel command-panel">
      <div class="panel-header">
        <div>
          <div class="section-kicker">Payment order</div>
          <h2>New transfer</h2>
        </div>
        ${button("Close", "close-payment-form", "", "ghost")}
      </div>
      <form class="form-grid" data-form="create-payment">
        <label>
          <span>Source wallet</span>
          <select name="sourceWalletId" required>
            ${data.wallets.map((wallet) => {
              const entity = findById(data.entities, wallet.entityId);
              return `<option value="${escapeHtml(wallet.id)}">${escapeHtml(entity?.name || wallet.entityId)} - ${escapeHtml(wallet.asset)} - ${escapeHtml(token(wallet.balance, wallet.asset))}</option>`;
            }).join("")}
          </select>
        </label>
        <label>
          <span>Counterparty</span>
          <select name="counterpartyId" required>
            ${data.counterparties.map((counterparty) => `<option value="${escapeHtml(counterparty.id)}">${escapeHtml(counterparty.name)} - ${escapeHtml(counterparty.status)}</option>`).join("")}
          </select>
        </label>
        <label>
          <span>Amount</span>
          <input name="amount" type="number" min="1" step="0.01" required>
        </label>
        <label>
          <span>Type</span>
          <select name="type">
            <option>Supplier</option>
            <option>Intra-group</option>
            <option>Liquidity</option>
          </select>
        </label>
        <label class="span-2">
          <span>Memo</span>
          <input name="memo" maxlength="120">
        </label>
        <div class="form-actions span-2">
          <button class="btn primary" type="submit" ${state.busy ? "disabled" : ""}>Create payment</button>
        </div>
      </form>
    </section>
  `;
}

function renderPaymentTable(payments, selectable) {
  if (!payments.length) return emptyState("No payments");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Reference</th>
            <th>Type</th>
            <th>Counterparty</th>
            <th>Amount</th>
            <th>Screen</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${payments.map((payment) => {
            const counterparty = findById(state.data.counterparties, payment.counterpartyId);
            const rowAction = selectable ? `data-action="select-payment" data-id="${escapeHtml(payment.id)}"` : "";
            return `
              <tr ${rowAction}>
                <td><strong>${escapeHtml(payment.reference)}</strong><span class="muted-cell">${escapeHtml(formatDate(payment.createdAt))}</span></td>
                <td>${escapeHtml(payment.type)}</td>
                <td>${escapeHtml(counterparty?.name || payment.counterpartyId)}</td>
                <td>${escapeHtml(token(payment.amount, payment.asset))}</td>
                <td>${badge(payment.screenResult)}</td>
                <td>${badge(payment.status)}</td>
                <td class="row-actions">${renderPaymentActions(payment, true)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderPaymentActions(payment, compact) {
  const parts = [];
  if (payment.status === "Pending approval") {
    parts.push(button(compact ? "Approve" : "Approve payment", "approve-payment", payment.id, "secondary"));
    parts.push(button(compact ? "Cancel" : "Cancel payment", "cancel-payment", payment.id, "ghost"));
  }
  if (payment.status === "Approved") {
    parts.push(button(compact ? "Execute" : "Execute payment", "execute-payment", payment.id, "primary"));
    parts.push(button(compact ? "Cancel" : "Cancel payment", "cancel-payment", payment.id, "ghost"));
  }
  if (payment.status === "Executing") {
    // Execution is resume-safe: re-calling execute on an Executing payment picks up where it
    // left off (wallet debit is idempotent) instead of leaving the payment stuck with no action.
    parts.push(button(compact ? "Retry" : "Retry execution", "retry-execution", payment.id, "primary"));
  }
  if (payment.status === "Failed") {
    parts.push(button(compact ? "Retry" : "Retry execution", "retry-execution", payment.id, "primary"));
  }
  return parts.join("");
}

function renderPaymentDetail(payment) {
  const data = state.data;
  const wallet = findById(data.wallets, payment.sourceWalletId);
  const entity = wallet ? findById(data.entities, wallet.entityId) : null;
  const counterparty = findById(data.counterparties, payment.counterpartyId);
  const recon = data.reconciliation.filter((entry) => entry.paymentId === payment.id);
  const journalLines = data.journalEntries.filter((entry) => entry.paymentId === payment.id);
  return `
    <div class="detail-grid">
      ${detail("Entity", entity?.name || "-")}
      ${detail("Counterparty", counterparty?.name || "-")}
      ${detail("Asset", payment.asset)}
      ${detail("Amount", token(payment.amount, payment.asset))}
      ${detail("Fee", token(payment.fee, payment.asset))}
      ${detail("Approvals", `${payment.approvals}/${payment.requiredApprovals}`)}
      ${detail("Provider ref", payment.providerRef || "-")}
      ${detail("Chain ref", payment.chainRef || "-")}
    </div>
    <div class="detail-memo">${escapeHtml(payment.memo || "No memo")}</div>
    <div class="action-strip">
      ${renderPaymentActions(payment, false) || `<span class="muted">No open payment action</span>`}
    </div>
    <div class="linked-strip">
      <span>${recon.length} reconciliation row${recon.length === 1 ? "" : "s"}</span>
      <span>${journalLines.length} journal line${journalLines.length === 1 ? "" : "s"}</span>
    </div>
  `;
}

function renderWalletsView() {
  const data = state.data;
  return `
    <section class="metric-grid">
      ${assetCards().join("")}
    </section>
    <section class="split-grid wide-first">
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Wallet registry</div>
            <h2>Balances</h2>
          </div>
        </div>
        ${renderWalletTable(data.wallets)}
      </div>
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Asset controls</div>
            <h2>Allowlist</h2>
          </div>
        </div>
        <div class="asset-list">
          ${data.assets.map((asset) => renderAssetPolicy(asset)).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderWalletTable(wallets, compact = false) {
  if (compact) {
    return `
      <div class="table-wrap compact-table">
        <table>
          <thead>
            <tr>
              <th>Entity</th>
              <th>Asset</th>
              <th>Provider</th>
              <th>Balance</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${wallets.map((wallet) => {
              const entity = findById(state.data.entities, wallet.entityId);
              const provider = findById(state.data.providers, wallet.providerId);
              return `
                <tr>
                  <td><strong>${escapeHtml(entity?.name || wallet.entityId)}</strong><span class="muted-cell">${escapeHtml(entity?.erpCode || "")}</span></td>
                  <td>${escapeHtml(wallet.asset)}</td>
                  <td>${escapeHtml(provider?.name || wallet.providerId)}</td>
                  <td>${escapeHtml(token(wallet.balance, wallet.asset))}</td>
                  <td>${badge(wallet.status)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Entity</th>
            <th>Asset</th>
            <th>Provider</th>
            <th>Address</th>
            <th>Balance</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${wallets.map((wallet) => {
            const entity = findById(state.data.entities, wallet.entityId);
            const provider = findById(state.data.providers, wallet.providerId);
            return `
              <tr>
                <td><strong>${escapeHtml(entity?.name || wallet.entityId)}</strong><span class="muted-cell">${escapeHtml(entity?.erpCode || "")}</span></td>
                <td>${escapeHtml(wallet.asset)}</td>
                <td>${escapeHtml(provider?.name || wallet.providerId)}</td>
                <td><code>${escapeHtml(wallet.address)}</code></td>
                <td>${escapeHtml(token(wallet.balance, wallet.asset))}</td>
                <td>${badge(wallet.status)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAssetPolicy(asset) {
  const enabled = state.data.policies.allowedAssets.includes(asset.id);
  const provider = findById(state.data.providers, asset.providerId);
  return `
    <article class="list-card">
      <div>
        <div class="card-title">${escapeHtml(asset.id)} - ${escapeHtml(asset.name)}</div>
        <div class="card-subtitle">${escapeHtml(asset.issuer)} / ${escapeHtml(asset.chain)} / ${escapeHtml(provider?.name || asset.providerId)}</div>
      </div>
      <div class="card-actions">
        ${badge(asset.status)}
        <button class="toggle ${enabled ? "is-on" : ""}" type="button" data-action="toggle-asset" data-id="${escapeHtml(asset.id)}" data-enabled="${enabled}">
          <span>${enabled ? "Allowed" : "Blocked"}</span>
        </button>
      </div>
    </article>
  `;
}

function assetCards() {
  const grouped = new Map();
  for (const wallet of state.data.wallets) {
    const current = grouped.get(wallet.asset) || { balance: 0, eur: 0, count: 0 };
    current.balance += Number(wallet.balance || 0);
    current.eur += walletValueEur(wallet);
    current.count += 1;
    grouped.set(wallet.asset, current);
  }
  return [...grouped.entries()].map(([asset, item]) => metricCard(asset, token(item.balance, asset), money(item.eur, "EUR")));
}

function renderControlsView() {
  const data = state.data;
  const policies = data.policies;
  return `
    <section class="split-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Policy engine</div>
            <h2>Thresholds</h2>
          </div>
        </div>
        <form class="form-grid" data-form="policy">
          <label>
            <span>Approval threshold</span>
            <input name="approvalThreshold" type="number" min="0" step="1000" value="${escapeHtml(policies.approvalThreshold)}">
          </label>
          <label>
            <span>Second approval</span>
            <input name="secondApprovalThreshold" type="number" min="0" step="1000" value="${escapeHtml(policies.secondApprovalThreshold)}">
          </label>
          <label>
            <span>Hard transfer limit</span>
            <input name="hardTransferLimit" type="number" min="0" step="1000" value="${escapeHtml(policies.hardTransferLimit)}">
          </label>
          <label>
            <span>Concentration limit</span>
            <input name="concentrationLimit" type="number" min="0" max="1" step="0.01" value="${escapeHtml(policies.concentrationLimit)}">
          </label>
          <div class="form-actions span-2">
            <button class="btn primary" type="submit" ${state.busy ? "disabled" : ""}>Save thresholds</button>
          </div>
        </form>
      </div>
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Rules</div>
            <h2>Active guardrails</h2>
          </div>
        </div>
        <div class="rule-list">
          ${rule("Screening", policies.requireScreening ? "Required" : "Disabled", policies.requireScreening ? "clear" : "warning")}
          ${rule("Allowed assets", policies.allowedAssets.join(", "), "clear")}
          ${rule("Allowed providers", String(policies.allowedProviders.length), "clear")}
          ${rule("Hard cap", money(policies.hardTransferLimit, "EUR"), "ready")}
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="section-kicker">Compliance registry</div>
          <h2>Counterparties</h2>
        </div>
      </div>
      ${renderCounterpartyTable(data.counterparties)}
    </section>
  `;
}

function renderCounterpartyTable(counterparties) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Jurisdiction</th>
            <th>Asset</th>
            <th>Risk</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${counterparties.map((counterparty) => `
            <tr>
              <td><strong>${escapeHtml(counterparty.name)}</strong><span class="muted-cell"><code>${escapeHtml(counterparty.wallet)}</code></span></td>
              <td>${escapeHtml(counterparty.type)}</td>
              <td>${escapeHtml(counterparty.jurisdiction)}</td>
              <td>${escapeHtml(counterparty.asset)}</td>
              <td>${badge(counterparty.risk)}</td>
              <td>${badge(counterparty.status)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderRepairView() {
  const repairItems = state.data.repair || [];
  return `
    <section class="metric-grid">
      ${metricCard("Repair queue", String(repairItems.length), "Executing and failed")}
      ${metricCard("Failed", String(repairItems.filter((item) => item.payment.status === "Failed").length), "Needs retry or review")}
      ${metricCard("Executing", String(repairItems.filter((item) => item.payment.status === "Executing").length), "Saga in progress")}
      ${metricCard("Errors", String(repairItems.filter((item) => latestAttempt(item)?.error).length), "Latest attempt")}
      ${metricCard("Retries", String(repairItems.reduce((sum, item) => sum + item.attempts.filter((attempt) => attempt.outcome === "error").length, 0)), "Recorded failures")}
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="section-kicker">Operator repair</div>
          <h2>Queue</h2>
        </div>
        ${button("Refresh", "refresh", "", "secondary")}
      </div>
      ${renderRepairTable(repairItems)}
    </section>
  `;
}

function renderRepairTable(items) {
  if (!items.length) return emptyState("No repairable payments");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Payment</th>
            <th>Status</th>
            <th>Amount</th>
            <th>Attempts</th>
            <th>Last signal</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item) => {
            const payment = item.payment;
            const last = latestAttempt(item);
            return `
              <tr>
                <td><strong>${escapeHtml(payment.reference)}</strong><span class="muted-cell">${escapeHtml(formatDate(payment.createdAt))}</span></td>
                <td>${badge(payment.status)}</td>
                <td>${escapeHtml(token(payment.amount, payment.asset))}</td>
                <td>${escapeHtml(String(item.attempts.length))}</td>
                <td><strong>${escapeHtml(last?.step || "-")}</strong><span class="muted-cell">${escapeHtml(last?.error || last?.outcome || "No attempt recorded")}</span></td>
                <td class="row-actions">${button("Retry", "retry-execution", payment.id, "primary")}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
    <div class="repair-attempts">
      ${items.map((item) => renderAttemptTrail(item)).join("")}
    </div>
  `;
}

function renderAttemptTrail(item) {
  const payment = item.payment;
  return `
    <article class="attempt-card">
      <div>
        <div class="card-title">${escapeHtml(payment.reference)}</div>
        <div class="card-subtitle">${escapeHtml(payment.status)} / ${escapeHtml(item.attempts.length)} attempt rows</div>
      </div>
      <div class="attempt-list">
        ${item.attempts.slice(-8).map((attempt) => `
          <span>${escapeHtml(attempt.step)} ${badge(attempt.outcome)} ${attempt.error ? `<em>${escapeHtml(attempt.error)}</em>` : ""}</span>
        `).join("") || `<span class="muted">No attempts yet</span>`}
      </div>
    </article>
  `;
}

function latestAttempt(item) {
  return item.attempts[item.attempts.length - 1] || null;
}

function renderReconciliationView() {
  const data = state.data;
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="section-kicker">Reconciliation</div>
          <h2>Exceptions</h2>
        </div>
        ${button("Simulate exception", "simulate-recon", "", "secondary")}
      </div>
      ${renderReconciliationTable(data.reconciliation)}
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="section-kicker">Accounting</div>
          <h2>Journal entries</h2>
        </div>
        ${button("Export batch", "export-accounting", "", "primary")}
      </div>
      ${renderJournalTable(data.journalEntries)}
    </section>
  `;
}

function renderReconciliationTable(rows) {
  if (!rows.length) return emptyState("No reconciliation rows");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Payment</th>
            <th>Source</th>
            <th>Issue</th>
            <th>Amount</th>
            <th>Owner</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => {
            const payment = findById(state.data.payments, row.paymentId);
            return `
              <tr>
                <td><strong>${escapeHtml(payment?.reference || row.paymentId)}</strong><span class="muted-cell">${escapeHtml(`${row.ageHours}h`)}</span></td>
                <td>${escapeHtml(row.source)}</td>
                <td>${escapeHtml(row.issue)}</td>
                <td>${escapeHtml(token(row.amount, row.asset))}</td>
                <td>${escapeHtml(row.owner)}</td>
                <td>${badge(row.status)}</td>
                <td class="row-actions">${row.status === "Open" ? button("Resolve", "resolve-recon", row.id, "secondary") : ""}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderJournalTable(rows) {
  if (!rows.length) return emptyState("No journal lines");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Entity</th>
            <th>Payment</th>
            <th>Account</th>
            <th>Debit</th>
            <th>Credit</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => {
            const entity = findById(state.data.entities, row.entityId);
            const payment = findById(state.data.payments, row.paymentId);
            return `
              <tr>
                <td>${escapeHtml(row.date)}</td>
                <td>${escapeHtml(entity?.erpCode || row.entityId)}</td>
                <td>${escapeHtml(payment?.reference || row.paymentId)}</td>
                <td>${escapeHtml(row.account)}</td>
                <td>${escapeHtml(row.debit ? money(row.debit, row.currency) : "-")}</td>
                <td>${escapeHtml(row.credit ? money(row.credit, row.currency) : "-")}</td>
                <td>${badge(row.status)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderOperationsView() {
  const data = state.data;
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="section-kicker">Providers</div>
          <h2>Route health</h2>
        </div>
        ${button("Simulate incident", "simulate-incident", "", "secondary")}
      </div>
      <div class="provider-grid">
        ${data.providers.map((provider) => renderProviderCard(provider)).join("")}
      </div>
    </section>
    <section class="split-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Alerts</div>
            <h2>Open events</h2>
          </div>
        </div>
        ${renderAlertList(data.alerts)}
      </div>
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="section-kicker">Audit trail</div>
            <h2>Latest events</h2>
          </div>
        </div>
        ${renderAuditList(data.audit)}
      </div>
    </section>
  `;
}

function renderProviderCard(provider) {
  return `
    <article class="provider-card">
      <div class="provider-head">
        <div>
          <div class="card-title">${escapeHtml(provider.name)}</div>
          <div class="card-subtitle">${escapeHtml(provider.type)} / ${escapeHtml(provider.authority)}</div>
        </div>
        ${badge(provider.status)}
      </div>
      <div class="provider-metrics">
        ${detail("Latency", `${provider.latencyMs}ms`)}
        ${detail("Uptime", `${provider.uptime}%`)}
        ${detail("Jurisdiction", provider.jurisdiction)}
        ${detail("Assets", provider.assets.join(", ") || "-")}
      </div>
      <div class="provider-routes">${provider.routes.map((routeName) => `<span>${escapeHtml(routeName)}</span>`).join("")}</div>
      <div class="provider-footer">
        <span class="muted">${escapeHtml(provider.incident || "No incident")}</span>
        ${button(provider.status === "Operational" ? "Degrade" : "Restore", "toggle-provider", provider.id, "secondary")}
      </div>
    </article>
  `;
}

function renderRiskLane() {
  const alerts = state.data.alerts.filter((alert) => alert.status === "Open").slice(0, 3);
  const exceptions = state.data.reconciliation.filter((row) => row.status === "Open").slice(0, 3);
  const items = [
    ...alerts.map((alert) => ({ title: alert.title, body: alert.detail, severity: alert.severity })),
    ...exceptions.map((row) => ({ title: row.issue, body: row.owner, severity: row.status }))
  ];
  if (!items.length) return emptyState("No open work");
  return `
    <div class="risk-list">
      ${items.map((item) => `
        <article class="list-card">
          <div>
            <div class="card-title">${escapeHtml(item.title)}</div>
            <div class="card-subtitle">${escapeHtml(item.body)}</div>
          </div>
          ${badge(item.severity)}
        </article>
      `).join("")}
    </div>
  `;
}

function renderAlertList(alerts) {
  if (!alerts.length) return emptyState("No alerts");
  return `<div class="risk-list">${alerts.map((alert) => `
    <article class="list-card">
      <div>
        <div class="card-title">${escapeHtml(alert.title)}</div>
        <div class="card-subtitle">${escapeHtml(alert.detail)}</div>
      </div>
      ${badge(alert.severity)}
    </article>
  `).join("")}</div>`;
}

function renderAuditList(audit) {
  if (!audit.length) return emptyState("No audit events");
  return `
    <div class="audit-list">
      ${audit.slice(0, 12).map((event) => `
        <article class="audit-item">
          <div class="audit-dot"></div>
          <div>
            <div class="card-title">${escapeHtml(event.action)}</div>
            <div class="card-subtitle">${escapeHtml(event.actor)} / ${escapeHtml(event.object)} / ${escapeHtml(formatDateTime(event.at))}</div>
            <div class="audit-detail">${escapeHtml(event.detail)}</div>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function computeMetrics(data) {
  const totalEur = data.wallets.reduce((sum, wallet) => sum + walletValueEur(wallet), 0);
  const eurValue = data.wallets
    .filter((wallet) => ["EURC", "EURI", "N-EURC"].includes(wallet.asset))
    .reduce((sum, wallet) => sum + walletValueEur(wallet), 0);
  return {
    blockedPayments: data.payments.filter((payment) => payment.status === "Blocked").length,
    degradedProviders: data.providers.filter((provider) => provider.status !== "Operational").length,
    eurAssetShare: totalEur ? eurValue / totalEur : 0,
    openExceptions: data.reconciliation.filter((row) => row.status === "Open").length,
    operationalProviders: data.providers.filter((provider) => provider.status === "Operational").length,
    pendingApprovals: data.payments.filter((payment) => payment.status === "Pending approval").length,
    readyJournals: data.journalEntries.filter((entry) => entry.status === "Ready").length,
    totalEur,
    walletCount: data.wallets.length
  };
}

function filteredPayments() {
  const search = state.filters.paymentSearch.toLowerCase();
  return state.data.payments.filter((payment) => {
    const counterparty = findById(state.data.counterparties, payment.counterpartyId);
    const matchesSearch = !search || [
      payment.reference,
      payment.type,
      payment.asset,
      payment.memo,
      payment.status,
      counterparty?.name
    ].some((value) => String(value || "").toLowerCase().includes(search));
    const matchesStatus = state.filters.paymentStatus === "All" || payment.status === state.filters.paymentStatus;
    return matchesSearch && matchesStatus;
  });
}

function metricCard(label, value, detailText) {
  return `
    <article class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="metric-detail">${escapeHtml(detailText)}</div>
    </article>
  `;
}

function detail(label, value) {
  return `
    <div class="detail-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function rule(label, value, tone) {
  return `
    <div class="rule-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${pill(tone === "clear" ? "On" : "Watch", tone)}
    </div>
  `;
}

function button(label, action, id = "", variant = "secondary") {
  const busy = state.busy ? "disabled" : "";
  const idAttr = id ? ` data-id="${escapeHtml(id)}"` : "";
  return `<button class="btn ${escapeHtml(variant)}" type="button" data-action="${escapeHtml(action)}"${idAttr} ${busy}>${escapeHtml(label)}</button>`;
}

function option(value, selected) {
  return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`;
}

function badge(value) {
  const label = String(value || "-");
  const className = statusClasses[label] || "status-muted";
  return `<span class="badge ${className}">${escapeHtml(label)}</span>`;
}

function pill(value, tone = "muted") {
  return `<span class="pill pill-${escapeHtml(tone)}">${escapeHtml(value)}</span>`;
}

function emptyState(label) {
  return `<div class="empty-state">${escapeHtml(label)}</div>`;
}

function showToast(message, tone) {
  state.toast = { message, tone };
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    state.toast = null;
    renderToast();
  }, 3200);
}

function renderToast() {
  if (!state.toast) {
    toastEl.innerHTML = "";
    return;
  }
  toastEl.innerHTML = `<div class="toast ${escapeHtml(state.toast.tone)}">${escapeHtml(state.toast.message)}</div>`;
}

function walletValueEur(wallet) {
  const rates = state.data?.ratesToEur || {};
  return Number(wallet.balance || 0) * (rates[wallet.asset] || 1);
}

function token(amount, asset) {
  const number = Number(amount || 0);
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: number % 1 ? 2 : 0 }).format(number)} ${asset}`;
}

function money(amount, currency) {
  return new Intl.NumberFormat("en-US", {
    currency,
    maximumFractionDigits: 0,
    style: "currency"
  }).format(Number(amount || 0));
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short"
  }).format(new Date(value));
}

function findById(items, id) {
  return items.find((item) => item.id === id);
}

function shortTenant(tenantId) {
  return `tenant ${String(tenantId).slice(-4)}`;
}

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) {
    return `ui:${globalThis.crypto.randomUUID()}`;
  }
  return `ui:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}
