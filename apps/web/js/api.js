import { state, FETCH_TIMEOUT_MS, toastEl } from "./state.js";
import { readableError, escapeHtml } from "./util.js";

let _render = () => {};
export function setRender(fn) { _render = fn; }
function render() { _render(); }

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
    // Q7: browser sessions are cookie-only; body may omit token.
    state.sessionToken = result.session?.token ? result.session.token : "cookie-managed";
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
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        // Session is HttpOnly cookie (same-origin credentials). CSRF header on mutations.
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
  if (state.selectedPaymentId) {
    void loadPaymentApprovals(state.selectedPaymentId).then(() => render());
  }
}

async function loadPaymentApprovals(paymentId) {
  if (!paymentId) return;
  try {
    const rows = await request(`/payments/${paymentId}/approvals`);
    state.paymentApprovals[paymentId] = Array.isArray(rows) ? rows : [];
  } catch {
    state.paymentApprovals[paymentId] = [];
  }
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

export {
  loadState,
  login,
  logout,
  post,
  request,
  receiveState,
  loadPaymentApprovals,
  showToast,
  renderToast
};
