import { state, statusClasses } from "./state.js";

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

function button(label, action, id = "", variant = "secondary", options = {}) {
  const disabled = state.busy || options.disabled ? "disabled" : "";
  const title = options.title ? ` title="${escapeHtml(options.title)}"` : "";
  const idAttr = id ? ` data-id="${escapeHtml(id)}"` : "";
  return `<button class="btn ${escapeHtml(variant)}" type="button" data-action="${escapeHtml(action)}"${idAttr}${title} ${disabled}>${escapeHtml(label)}</button>`;
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

// Escapes by default, like the sibling helpers. Headers and string cells are escaped; a cell
// that must carry markup is passed as { html: "<strong>…</strong>" } (inserted inside a <td>)
// or { td: "<td class=\"row-actions\">…</td>" } (inserted as the whole cell).
function table(headers, rows, { className = "", rowAttributes = () => "" } = {}) {
  return `
    <div class="table-wrap${className ? ` ${className}` : ""}">
      <table>
        <thead>
          <tr>
            ${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("\n")}
          </tr>
        </thead>
        <tbody>
          ${rows.map((cells, index) => {
            const attributes = rowAttributes(index);
            return `
              <tr${attributes ? ` ${attributes}` : ""}>
                ${cells.map(tableCell).join("\n")}
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function tableCell(cell) {
  if (cell && typeof cell === "object") {
    if (cell.td !== undefined) return cell.td;
    if (cell.html !== undefined) return `<td>${cell.html}</td>`;
    return "<td></td>";
  }
  return `<td>${escapeHtml(cell)}</td>`;
}

function panel({ kicker, title, titleHtml, actions = "", body = "", className = "", headerClass = "", tag = "section" } = {}) {
  return `
    <${tag} class="panel${className ? ` ${className}` : ""}">
      <div class="panel-header${headerClass ? ` ${headerClass}` : ""}">
        <div>
          <div class="section-kicker">${escapeHtml(kicker)}</div>
          <h2>${titleHtml === undefined ? escapeHtml(title) : titleHtml}</h2>
        </div>
        ${actions}
      </div>
      ${body}
    </${tag}>
  `;
}

function listCard(title, subtitle, trailing = "") {
  return `
    <article class="list-card">
      <div>
        <div class="card-title">${escapeHtml(title)}</div>
        <div class="card-subtitle">${escapeHtml(subtitle)}</div>
      </div>
      ${trailing}
    </article>
  `;
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

export {
  computeMetrics,
  filteredPayments,
  metricCard,
  detail,
  rule,
  button,
  option,
  badge,
  pill,
  emptyState,
  table,
  panel,
  listCard,
  walletValueEur,
  token,
  money,
  formatDate,
  formatDateTime,
  findById,
  shortTenant,
  createIdempotencyKey,
  readableError,
  escapeHtml
};
