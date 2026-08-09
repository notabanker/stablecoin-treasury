import { state, views, appEl } from "./state.js";
import {
  badge, button, detail, emptyState, findById, formatDate, formatDateTime,
  metricCard, money, option, pill, rule, shortTenant, token, walletValueEur,
  computeMetrics, filteredPayments, escapeHtml
} from "./util.js";
import { renderToast } from "./api.js";
import { renderOverviewView, renderPaymentsView } from "./views-payments.js";
import { renderWalletsView, renderControlsView } from "./views-wallets.js";
import { renderRepairView, renderReconciliationView, renderOperationsView } from "./views-ops.js";

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

export {
  render,
  renderLogin,
  renderBoot,
  renderServiceError,
  renderNavItem,
  renderSidebarStatus,
  renderTopbar,
  renderStaleBanner,
  viewTitle,
  renderActiveView
};
