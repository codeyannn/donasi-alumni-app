/**
 * auth.js
 * Google Identity Services initialization and session management.
 */

function isLocalDemoEnabled() {
  if (!CONFIG || CONFIG.DEMO_MODE !== true) return false;
  const host = window.location && window.location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}

function initGoogleButton() {
  const container = document.getElementById("googleBtnContainer");
  if (!container) return;

  if (window.google && CONFIG.GOOGLE_CLIENT_ID) {
    google.accounts.id.initialize({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      callback: handleGoogleCredentialResponse,
    });
    google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
      width: 280,
    });
  } else {
    container.innerHTML =
      '<span style="font-size: 12px; color: var(--text-dim);">Google Client ID belum diatur atau pustaka Google Sign-In masih dimuat.</span>';
  }
}

async function handleGoogleCredentialResponse(response) {
  const idToken = response.credential;
  const consent = document.getElementById("privacyConsent")
    ? document.getElementById("privacyConsent").checked
    : true;

  // Enforce Alumni-only role on Google Sign-In; GUEST donations no longer use Google Auth (P4)
  const normalizedRole = "ALUMNI";

  try {
    const res = await API.post("register_or_login", {
      id_token: idToken,
      role: normalizedRole,
      consent: consent,
    });

    if (res.status === "ok") {
      window.localStorage.setItem("DONASI_USER", JSON.stringify(res.user));
      window.localStorage.setItem("DONASI_TOKEN", idToken);
      window.location.href = "app.html";
    } else {
      alert("Gagal login: " + (res.message || "Terjadi kesalahan sistem"));
    }
  } catch (err) {
    alert("Error menghubungkan ke server: " + err.message);
  }
}

function getCurrentUser() {
  const raw = window.localStorage.getItem("DONASI_USER");
  return raw ? JSON.parse(raw) : null;
}

function getAuthToken() {
  return window.localStorage.getItem("DONASI_TOKEN") || "";
}

function logout() {
  window.localStorage.removeItem("DONASI_USER");
  window.localStorage.removeItem("DONASI_TOKEN");
  window.location.href = "index.html";
}

function renderNavRight() {
  const nav = document.getElementById("navRight");
  if (!nav) return;
  const user = getCurrentUser();

  if (user) {
    const roleBadge =
      user.role === "ADMIN"
        ? '<span class="badge badge-alert">ADMIN</span>'
        : user.role === "ALUMNI"
          ? '<span class="badge badge-alert">ALUMNI</span>'
          : '<span class="badge badge-neutral">TAMU</span>';

    // Display admin portal button strictly based on server-derived ADMIN role
    const adminLink =
      user.role === "ADMIN"
        ? '<a href="admin.html" class="btn btn-secondary" style="font-size: 11px; padding: 5px 10px; margin-right: 6px;">Portal Admin</a>'
        : "";

    nav.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        ${adminLink}
        <a href="app.html" class="btn btn-secondary" style="font-size: 11px; padding: 5px 10px;">Dasbor Saya</a>
        <div style="text-align: right; margin: 0 4px;">
          <div style="font-size: 12px; font-weight: 700;">${escapeNav(user.full_name || user.email)} ${roleBadge}</div>
          <div style="font-size: 11px; color: var(--text-dim); font-family: var(--font-mono);">${escapeNav(user.ref_code || "Belum Verifikasi")}</div>
        </div>
        <button onclick="logout()" class="btn btn-secondary" style="font-size: 11px; padding: 5px 8px;">Keluar</button>
      </div>
    `;
  } else {
    nav.innerHTML = `
      <a href="index.html" class="btn btn-primary" style="font-size: 12px; padding: 6px 14px;">Masuk / Donasi</a>
    `;
  }
}

function escapeNav(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

document.addEventListener("DOMContentLoaded", renderNavRight);
