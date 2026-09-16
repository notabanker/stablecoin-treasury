import { state } from "./state.js";
import {
  badge, button, detail, emptyState, findById, formatDate,
  metricCard, money, option, panel, pill, table, token,
  computeMetrics, filteredPayments, escapeHtml
} from "./util.js";
import { renderCounterpartyTable, renderWalletTable } from "./views-wallets.js";
import { renderRiskLane } from "./views-ops.js";

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
      ${panel({
        tag: "div", kicker: "Liquidity", title: "Wallet coverage",
        actions: pill(`${Math.round(metrics.eurAssetShare * 100)}% EUR exposure`, metrics.eurAssetShare > 0.5 ? "clear" : "warning"),
        body: renderWalletTable(data.wallets.slice(0, 6), true)
      })}
      ${panel({ tag: "div", kicker: "Risk lane", title: "Open work", body: renderRiskLane() })}
    </section>

    ${panel({
      kicker: "Payment rail", title: "Recent movements", actions: button("View payments", "navigate", "payments", "secondary"),
      body: renderPaymentTable(data.payments.slice(0, 5), false)
    })}
  `;
}

function renderPaymentsView() {
  const data = state.data;
  const payments = filteredPayments();
  const selected = data.payments.find((payment) => payment.id === state.selectedPaymentId) || data.payments[0];
  return `
    ${state.showPaymentForm ? renderPaymentForm() : ""}
    ${panel({
      kicker: "Payment operations", title: "Queue", headerClass: "command-header",
      actions: `
        <form class="filter-form" data-form="payment-filter">
          <input name="paymentSearch" type="search" value="${escapeHtml(state.filters.paymentSearch)}" aria-label="Search payments">
          <select name="paymentStatus" aria-label="Payment status">
            ${["All", "Pending approval", "Approved", "Executing", "Settled", "Blocked", "Cancelled", "Failed"].map((status) => option(status, state.filters.paymentStatus)).join("")}
          </select>
          <button class="btn secondary" type="submit">Filter</button>
        </form>
      `,
      body: renderPaymentTable(payments, true)
    })}
    <section class="split-grid">
      ${panel({
        tag: "div", kicker: "Selected payment", title: selected?.reference || "None",
        actions: selected ? badge(selected.status) : "",
        body: selected ? renderPaymentDetail(selected) : emptyState("No payment selected")
      })}
      ${panel({ tag: "div", kicker: "Counterparties", title: "Screening status", body: renderCounterpartyTable(data.counterparties) })}
    </section>
  `;
}

function renderPaymentForm() {
  const data = state.data;
  return panel({
    className: "command-panel", kicker: "Payment order", title: "New transfer",
    actions: button("Close", "close-payment-form", "", "ghost"),
    body: `
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
    `
  });
}

function renderPaymentTable(payments, selectable) {
  if (!payments.length) return emptyState("No payments");
  return table(
    ["Reference", "Type", "Counterparty", "Amount", "Screen", "Status", ""],
    payments.map((payment) => {
      const counterparty = findById(state.data.counterparties, payment.counterpartyId);
      return [
        { html: `<strong>${escapeHtml(payment.reference)}</strong><span class="muted-cell">${escapeHtml(formatDate(payment.createdAt))}</span>` },
        payment.type,
        counterparty?.name || payment.counterpartyId,
        token(payment.amount, payment.asset),
        { html: badge(payment.screenResult) },
        { html: badge(payment.status) },
        { td: `<td class="row-actions">${renderPaymentActions(payment, true)}</td>` }
      ];
    }),
    {
      rowAttributes: (index) => (selectable
        ? `data-action="select-payment" data-id="${escapeHtml(payments[index].id)}"`
        : " ")
    }
  );
}

function renderApprovalsList(payment) {
  const parts = [];
  const creatorLabel = payment.createdByDisplay || payment.createdBy;
  if (creatorLabel) {
    parts.push(`<div class=\"approval-row\"><span class=\"approval-actor\">${escapeHtml(creatorLabel)}</span> <span class=\"approval-action\">created</span></div>`);
  }
  const approvals = state.paymentApprovals[payment.id] || [];
  for (const row of approvals) {
    const when = row.approvedAt ? formatDate(row.approvedAt) : "";
    parts.push(`<div class=\"approval-row\"><span class=\"approval-actor\">${escapeHtml(row.display || row.approverId || "Approver")}</span> <span class=\"approval-action\">approved</span>${when ? `<span class=\"muted-cell\">${escapeHtml(when)}</span>` : ""}</div>`);
  }
  if (payment.approvals > 0) {
    parts.push(`<div class=\"approval-row\"><span class=\"approval-count\">${payment.approvals}/${payment.requiredApprovals}</span> <span class=\"approval-action\">approvals completed</span></div>`);
    if (payment.approvals >= payment.requiredApprovals && payment.status === "Approved") {
      parts.push(`<div class=\"approval-row\"><span class=\"approval-status-badge\">✓ Fully approved</span></div>`);
    }
  }
  if (parts.length === 0) return "";
  return `<div class=\"approval-list\">${parts.join("")}</div>`;
}

function renderPaymentActions(payment, compact) {
  const parts = [];
  const currentUserId = state.data?.currentUser?.id;
  const creatorBlocked = Boolean(
    payment.createdBy
    && currentUserId
    && currentUserId !== "anon"
    && payment.createdBy === currentUserId
  );
  if (payment.status === "Pending approval") {
    parts.push(button(
      compact ? "Approve" : "Approve payment",
      "approve-payment",
      payment.id,
      "secondary",
      { disabled: creatorBlocked, title: creatorBlocked ? "Creators cannot approve their own payment" : "" }
    ));
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
      ${detail("Created by", payment.createdBy || "-")}
      ${detail("Approvals", `${payment.approvals}/${payment.requiredApprovals}`)}
      ${payment.createdBy ? detail("Creator", payment.createdBy) : ""}
      ${detail("Provider ref", payment.providerRef || "-")}
      ${detail("Chain ref", payment.chainRef || "-")}
    </div>
    <div class="detail-memo">${escapeHtml(payment.memo || "No memo")}</div>
    ${renderApprovalsList(payment)}
    <div class="action-strip">
      ${renderPaymentActions(payment, false) || `<span class="muted">No open payment action</span>`}
    </div>
    <div class="linked-strip">
      <span>${recon.length} reconciliation row${recon.length === 1 ? "" : "s"}</span>
      <span>${journalLines.length} journal line${journalLines.length === 1 ? "" : "s"}</span>
    </div>
  `;
}

export {
  renderOverviewView,
  renderPaymentsView,
  renderPaymentForm,
  renderPaymentTable,
  renderApprovalsList,
  renderPaymentActions,
  renderPaymentDetail
};
