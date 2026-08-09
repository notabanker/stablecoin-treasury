import { state } from "./js/state.js";
import { createIdempotencyKey } from "./js/util.js";
import { loadState, login, logout, post, setRender, loadPaymentApprovals } from "./js/api.js";
import { render } from "./js/views-shell.js";

setRender(render);

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
      await loadPaymentApprovals(id);
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
      if (action === "approve-payment" && state.selectedPaymentId) {
        await loadPaymentApprovals(state.selectedPaymentId);
        render();
      }
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
