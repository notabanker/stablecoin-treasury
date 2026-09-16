import { state } from "./state.js";
import {
  badge, escapeHtml, findById, listCard, metricCard,
  money, panel, rule, table, token, walletValueEur
} from "./util.js";

function renderWalletsView() {
  const data = state.data;
  return `
    <section class="metric-grid">
      ${assetCards().join("")}
    </section>
    <section class="split-grid wide-first">
      ${panel({ tag: "div", kicker: "Wallet registry", title: "Balances", body: renderWalletTable(data.wallets) })}
      ${panel({
        tag: "div", kicker: "Asset controls", title: "Allowlist",
        body: `<div class="asset-list">${data.assets.map((asset) => renderAssetPolicy(asset)).join("")}</div>`
      })}
    </section>
  `;
}

function renderWalletTable(wallets, compact = false) {
  const headers = ["Entity", "Asset", "Provider", ...(compact ? [] : ["Address"]), "Balance", "Status"];
  const rows = wallets.map((wallet) => {
    const entity = findById(state.data.entities, wallet.entityId);
    const provider = findById(state.data.providers, wallet.providerId);
    return [
      { html: `<strong>${escapeHtml(entity?.name || wallet.entityId)}</strong><span class="muted-cell">${escapeHtml(entity?.erpCode || "")}</span>` },
      wallet.asset,
      provider?.name || wallet.providerId,
      ...(compact ? [] : [{ html: `<code>${escapeHtml(wallet.address)}</code>` }]),
      token(wallet.balance, wallet.asset),
      { html: badge(wallet.status) }
    ];
  });
  return table(headers, rows, { className: compact ? "compact-table" : "" });
}

function renderAssetPolicy(asset) {
  const enabled = state.data.policies.allowedAssets.includes(asset.id);
  const provider = findById(state.data.providers, asset.providerId);
  const trailing = `
    <div class="card-actions">
      ${badge(asset.status)}
      <button class="toggle ${enabled ? "is-on" : ""}" type="button" data-action="toggle-asset" data-id="${escapeHtml(asset.id)}" data-enabled="${enabled}">
        <span>${enabled ? "Allowed" : "Blocked"}</span>
      </button>
    </div>
  `;
  return listCard(`${asset.id} - ${asset.name}`, `${asset.issuer} / ${asset.chain} / ${provider?.name || asset.providerId}`, trailing);
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
      ${panel({
        tag: "div", kicker: "Policy engine", title: "Thresholds",
        body: `
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
        `
      })}
      ${panel({
        tag: "div", kicker: "Rules", title: "Active guardrails",
        body: `
          <div class="rule-list">
            ${rule("Screening", policies.requireScreening ? "Required" : "Disabled", policies.requireScreening ? "clear" : "warning")}
            ${rule("Allowed assets", policies.allowedAssets.join(", "), "clear")}
            ${rule("Allowed providers", String(policies.allowedProviders.length), "clear")}
            ${rule("Hard cap", money(policies.hardTransferLimit, "EUR"), "ready")}
          </div>
        `
      })}
    </section>
    ${panel({ kicker: "Compliance registry", title: "Counterparties", body: renderCounterpartyTable(data.counterparties) })}
  `;
}

function renderCounterpartyTable(counterparties) {
  return table(
    ["Name", "Type", "Jurisdiction", "Asset", "Risk", "Status"],
    counterparties.map((counterparty) => [
      { html: `<strong>${escapeHtml(counterparty.name)}</strong><span class="muted-cell"><code>${escapeHtml(counterparty.wallet)}</code></span>` },
      counterparty.type,
      counterparty.jurisdiction,
      counterparty.asset,
      { html: badge(counterparty.risk) },
      { html: badge(counterparty.status) }
    ])
  );
}

export {
  renderWalletsView,
  renderWalletTable,
  renderAssetPolicy,
  assetCards,
  renderControlsView,
  renderCounterpartyTable
};
