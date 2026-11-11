/**
 * admin.js
 * Admin portal functionality: verification reviewing, queue resolution, and stats.
 */

async function initAdminPortal() {
  const user = getCurrentUser();
  if (
    !user ||
    (user.role !== "ADMIN" && user.email !== "maulanaa1408@upi.edu")
  ) {
    alert("Akses terbatas hanya untuk administrator sistem.");
    window.location.href = "index.html";
    return;
  }

  await loadAdminVerifications();
  await loadAdminQueue();
  await loadAdminInsights();
}

function switchTab(tab) {
  document.getElementById("sectionVerif").style.display =
    tab === "verif" ? "block" : "none";
  document.getElementById("sectionQueue").style.display =
    tab === "queue" ? "block" : "none";
  document.getElementById("sectionInsights").style.display =
    tab === "insights" ? "block" : "none";

  document.getElementById("tabBtnVerif").className =
    tab === "verif" ? "btn btn-primary" : "btn btn-secondary";
  document.getElementById("tabBtnQueue").className =
    tab === "queue" ? "btn btn-primary" : "btn btn-secondary";
  document.getElementById("tabBtnInsights").className =
    tab === "insights" ? "btn btn-primary" : "btn btn-secondary";
}

async function loadAdminVerifications() {
  try {
    const res = await API.get("admin_verifications", {
      id_token: getAuthToken(),
    });
    if (res.status === "ok") {
      const tbody = document.getElementById("verifTableBody");
      tbody.innerHTML = "";
      const items = res.items || [];
      const pendingCount = items.filter((i) => i.status === "PENDING").length;
      document.getElementById("verifBadgeCount").innerText = pendingCount;

      if (items.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 24px;">Belum ada antrean verifikasi alumni.</td></tr>';
        return;
      }

      items.forEach((item) => {
        const tr = document.createElement("tr");
        const statusBadge =
          item.status === "VERIFIED"
            ? '<span class="badge badge-verified">VERIFIED</span>'
            : item.status === "PENDING"
              ? '<span class="badge badge-pending">PENDING</span>'
              : '<span class="badge badge-alert">REJECTED</span>';

        let actions = "-";
        if (item.status === "PENDING") {
          actions = `
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-success" style="font-size: 11px; padding: 4px 8px;" onclick="handleReview('${item.verif_id}', true)">Setujui</button>
              <button class="btn btn-danger" style="font-size: 11px; padding: 4px 8px;" onclick="handleReview('${item.verif_id}', false)">Tolak</button>
            </div>
          `;
        }

        tr.innerHTML = `
          <td>${escapeAdmin(item.submitted_at || "-")}</td>
          <td><strong>${escapeAdmin(item.full_name)}</strong></td>
          <td>${escapeAdmin(item.email)}</td>
          <td><code style="font-family: var(--font-mono); font-size: 12px;">${escapeAdmin(item.nim)}</code></td>
          <td>${escapeAdmin(item.grad_year)}</td>
          <td>${escapeAdmin(item.faculty)}</td>
          <td>${statusBadge}</td>
          <td>${actions}</td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error("Error fetching verifications:", err);
  }
}

async function handleReview(verifId, approve) {
  let reason = "";
  if (!approve) {
    reason = prompt(
      "Masukkan alasan penolakan verifikasi (akan dikirimkan ke email user):",
      "Dokumen tidak sesuai catatan kelulusan UPI",
    );
    if (reason === null) return;
  } else {
    if (
      !confirm(
        "Setujui alumni ini? Sistem akan menerbitkan kode ID Unik Alumni (A000xxx) dan menghapus dokumen bukti dari Drive sesuai prinsip minimisasi data UU No. 27/2022.",
      )
    ) {
      return;
    }
  }

  try {
    const res = await API.post("review_verification", {
      id_token: getAuthToken(),
      verif_id: verifId,
      approve: approve,
      reason: reason,
    });

    if (res.status === "ok") {
      alert(
        approve
          ? `Alumni berhasil disetujui! Diterbitkan Ref Code: ${res.ref_code}`
          : "Pengajuan alumni ditolak.",
      );
      await loadAdminVerifications();
    } else {
      alert("Gagal memproses: " + (res.message || "Error"));
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function loadAdminQueue() {
  try {
    const res = await API.get("admin_queue", { id_token: getAuthToken() });
    if (res.status === "ok") {
      const tbody = document.getElementById("queueTableBody");
      tbody.innerHTML = "";
      const items = res.items || [];
      const pendingCount = items.filter((i) => i.status === "PENDING").length;
      document.getElementById("queueBadgeCount").innerText = pendingCount;

      if (items.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: 24px;">Tidak ada mutasi unmatched. Semua transaksi berhasil dicocokkan otomatis!</td></tr>';
        return;
      }

      items.forEach((q) => {
        const tr = document.createElement("tr");
        const statusBadge =
          q.status === "RESOLVED"
            ? `<span class="badge badge-verified">RESOLVED (${escapeAdmin(q.assigned_ref_code || "")})</span>`
            : '<span class="badge badge-alert">PENDING REVIEW</span>';

        let actionHtml = "-";
        if (q.status === "PENDING") {
          actionHtml = `
            <div style="display: flex; gap: 4px;">
              <input type="text" id="targetRef_${q.queue_id}" placeholder="A000xxx / G000xxx" style="width: 100px; font-family: var(--font-mono); font-size: 11px; padding: 4px 6px; border: 1px solid var(--border-mid); border-radius: var(--radius-sm);">
              <button class="btn btn-primary" style="font-size: 11px; padding: 4px 8px;" onclick="handleResolveQueue('${q.queue_id}')">Tautkan</button>
            </div>
          `;
        }

        tr.innerHTML = `
          <td>${escapeAdmin(q.tx_date || "-")}</td>
          <td><strong>${escapeAdmin(q.bank)}</strong></td>
          <td style="color: var(--crimson-700); font-weight: 700;">${escapeAdmin(q.formatted_amount)}</td>
          <td style="font-family: var(--font-mono); font-size: 11px; max-width: 200px; word-break: break-all;">${escapeAdmin(q.description)}</td>
          <td style="font-size: 12px; color: var(--crimson-700);">${escapeAdmin(q.reason)}</td>
          <td>${statusBadge}</td>
          <td>${actionHtml}</td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error("Error fetching admin queue:", err);
  }
}

async function handleResolveQueue(queueId) {
  const input = document.getElementById(`targetRef_${queueId}`);
  if (!input || !input.value.trim()) {
    alert("Masukkan kode referensi donatur (misal: A000471 atau G000012).");
    return;
  }
  const targetCode = input.value.trim().toUpperCase();

  try {
    const res = await API.post("resolve_queue", {
      id_token: getAuthToken(),
      queue_id: queueId,
      target_ref_code: targetCode,
    });

    if (res.status === "ok") {
      alert(
        `Transaksi berhasil ditautkan ke ${targetCode}! Email tanda terima donasi otomatis terkirim ke donatur.`,
      );
      await loadAdminQueue();
    } else {
      alert("Gagal menautkan: " + (res.message || "Error"));
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function loadAdminInsights() {
  try {
    const res = await API.get("admin_insights", { id_token: getAuthToken() });
    if (res.status === "ok") {
      document.getElementById("insightTotalAmount").innerText =
        res.formatted_total || "Rp 0";
      document.getElementById("insightTotalCount").innerText =
        `${res.total_count || 0} Mutasi`;
      document.getElementById("insightVerifiedAlumni").innerText =
        `${(res.demographics && res.demographics.verified_alumni) || 0} Alumni`;

      const t = res.tier_distribution || {};
      document.getElementById("tierInsightBox").innerHTML = `
        <div>&bull; <strong>Tier 1 (Ref Code di Berita Bank):</strong> ${t["1"] || 0} mutasi (Otomatis 100%)</div>
        <div>&bull; <strong>Tier 2 (Intent Match Bank+Nominal):</strong> ${t["2"] || 0} mutasi (Otomatis)</div>
        <div>&bull; <strong>Tier 3 (Unmatched Review Queue):</strong> ${t["3"] || 0} mutasi</div>
        <div>&bull; <strong>Tautan Manual Admin:</strong> ${t["MANUAL"] || 0} mutasi</div>
      `;

      const b = res.bank_breakdown || {};
      let bHtml = "";
      for (const [bank, amount] of Object.entries(b)) {
        bHtml += `<div>&bull; <strong>${escapeAdmin(bank)}:</strong> Rp ${Number(amount).toLocaleString("id-ID")}</div>`;
      }
      document.getElementById("bankInsightBox").innerHTML =
        bHtml || "Belum ada transaksi.";
    }
  } catch (err) {
    console.error("Error fetching admin insights:", err);
  }
}

function escapeAdmin(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

document.addEventListener("DOMContentLoaded", initAdminPortal);
