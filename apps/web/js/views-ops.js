import { state, views, appEl } from "./state.js";
import {
  badge, button, detail, emptyState, findById, formatDate, formatDateTime,
  metricCard, money, option, pill, rule, shortTenant, token, walletValueEur,
  computeMetrics, filteredPayments, escapeHtml, createIdempotencyKey
} from "./util.js";
import { post, loadPaymentApprovals, renderToast } from "./api.js";

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

export {
  renderRepairView,
  renderRepairTable,
  renderAttemptTrail,
  latestAttempt,
  renderReconciliationView,
  renderReconciliationTable,
  renderJournalTable,
  renderOperationsView,
  renderProviderCard,
  renderRiskLane,
  renderAlertList,
  renderAuditList
};
