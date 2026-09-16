import { state } from "./state.js";
import {
  badge, button, detail, emptyState, findById, formatDate,
  formatDateTime, listCard, metricCard, money, panel, table,
  token, escapeHtml
} from "./util.js";

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
    ${panel({
      kicker: "Operator repair", title: "Queue", actions: button("Refresh", "refresh", "", "secondary"),
      body: renderRepairTable(repairItems)
    })}
  `;
}

function renderRepairTable(items) {
  if (!items.length) return emptyState("No repairable payments");
  return `
    ${table(
      ["Payment", "Status", "Amount", "Attempts", "Last signal", ""],
      items.map((item) => {
        const payment = item.payment;
        const last = latestAttempt(item);
        return [
          `<strong>${escapeHtml(payment.reference)}</strong><span class="muted-cell">${escapeHtml(formatDate(payment.createdAt))}</span>`,
          badge(payment.status),
          escapeHtml(token(payment.amount, payment.asset)),
          escapeHtml(String(item.attempts.length)),
          `<strong>${escapeHtml(last?.step || "-")}</strong><span class="muted-cell">${escapeHtml(last?.error || last?.outcome || "No attempt recorded")}</span>`,
          `<td class="row-actions">${button("Retry", "retry-execution", payment.id, "primary")}</td>`
        ];
      })
    )}
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
    ${panel({
      kicker: "Reconciliation", title: "Exceptions", actions: button("Simulate exception", "simulate-recon", "", "secondary"),
      body: renderReconciliationTable(data.reconciliation)
    })}
    ${panel({
      kicker: "Accounting", title: "Journal entries", actions: button("Export batch", "export-accounting", "", "primary"),
      body: renderJournalTable(data.journalEntries)
    })}
  `;
}

function renderReconciliationTable(rows) {
  if (!rows.length) return emptyState("No reconciliation rows");
  return table(
    ["Payment", "Source", "Issue", "Amount", "Owner", "Status", ""],
    rows.map((row) => {
      const payment = findById(state.data.payments, row.paymentId);
      return [
        `<strong>${escapeHtml(payment?.reference || row.paymentId)}</strong><span class="muted-cell">${escapeHtml(`${row.ageHours}h`)}</span>`,
        escapeHtml(row.source),
        escapeHtml(row.issue),
        escapeHtml(token(row.amount, row.asset)),
        escapeHtml(row.owner),
        badge(row.status),
        `<td class="row-actions">${row.status === "Open" ? button("Resolve", "resolve-recon", row.id, "secondary") : ""}</td>`
      ];
    })
  );
}

function renderJournalTable(rows) {
  if (!rows.length) return emptyState("No journal lines");
  return table(
    ["Date", "Entity", "Payment", "Account", "Debit", "Credit", "Status"],
    rows.map((row) => {
      const entity = findById(state.data.entities, row.entityId);
      const payment = findById(state.data.payments, row.paymentId);
      return [
        escapeHtml(row.date),
        escapeHtml(entity?.erpCode || row.entityId),
        escapeHtml(payment?.reference || row.paymentId),
        escapeHtml(row.account),
        escapeHtml(row.debit ? money(row.debit, row.currency) : "-"),
        escapeHtml(row.credit ? money(row.credit, row.currency) : "-"),
        badge(row.status)
      ];
    })
  );
}

function renderOperationsView() {
  const data = state.data;
  return `
    ${panel({
      kicker: "Providers", title: "Route health", actions: button("Simulate incident", "simulate-incident", "", "secondary"),
      body: `<div class="provider-grid">${data.providers.map((provider) => renderProviderCard(provider)).join("")}</div>`
    })}
    <section class="split-grid">
      ${panel({ tag: "div", kicker: "Alerts", title: "Open events", body: renderAlertList(data.alerts) })}
      ${panel({ tag: "div", kicker: "Audit trail", title: "Latest events", body: renderAuditList(data.audit) })}
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
      ${items.map((item) => listCard(item.title, item.body, badge(item.severity))).join("")}
    </div>
  `;
}

function renderAlertList(alerts) {
  if (!alerts.length) return emptyState("No alerts");
  return `<div class="risk-list">${alerts.map((alert) => listCard(alert.title, alert.detail, badge(alert.severity))).join("")}</div>`;
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
