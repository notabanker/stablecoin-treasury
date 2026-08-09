import { state } from "./state.js";
import {
  badge, button, findById, formatDate, formatDateTime,
  metricCard, money, rule, token, walletValueEur,
  escapeHtml
} from "./util.js";

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

export {
  renderWalletsView,
  renderWalletTable,
  renderAssetPolicy,
  assetCards,
  renderControlsView,
  renderCounterpartyTable
};
