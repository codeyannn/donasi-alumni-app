/**
 * admin.js
 * Admin portal functionality: verification reviewing, queue resolution, and stats.
 */

var adminAuditLimit = 25;
var adminAuditOffset = 0;
var cachedAdminTransactions = [];

async function initAdminPortal() {
  const user = getCurrentUser();
  // Rely on backend-assigned ADMIN role rather than client email fallback
  if (!user || user.role !== "ADMIN") {
    alert("Akses terbatas hanya untuk administrator sistem.");
    window.location.href = "index.html";
    return;
  }

  await loadAdminVerifications();
  await loadAdminQueue();
  await loadAdminTransactions();
  await loadAdminPrograms();
  await loadAdminInsights();
  await loadAdminAuditLogs(0);
}

function switchTab(tab) {
  const sectionMap = {
    verif: "sectionVerif",
    queue: "sectionQueue",
    transactions: "sectionTransactions",
    programs: "sectionPrograms",
    insights: "sectionInsights",
    audit: "sectionAuditLogs",
  };
  const buttonMap = {
    verif: "tabBtnVerif",
    queue: "tabBtnQueue",
    transactions: "tabBtnTransactions",
    programs: "tabBtnPrograms",
    insights: "tabBtnInsights",
    audit: "tabBtnAuditLogs",
  };

  Object.entries(sectionMap).forEach(([key, secId]) => {
    const el = document.getElementById(secId);
    if (el) el.style.display = tab === key ? "block" : "none";
  });

  Object.entries(buttonMap).forEach(([key, btnId]) => {
    const btn = document.getElementById(btnId);
    if (btn) btn.className = tab === key ? "btn btn-primary" : "btn btn-secondary";
  });
}

function normalizeAdminVerifStatus(status) {
  const raw = String(status || "").trim().toUpperCase();
  if (!raw || raw === "NONE" || raw === "NOT_SUBMITTED") return "NOT_SUBMITTED";
  if (raw === "VERIFIED" || raw === "APPROVED") return "APPROVED";
  if (raw === "PENDING" || raw === "NEEDS_REVISION" || raw === "REJECTED") return raw;
  return "NOT_SUBMITTED";
}

function renderAdminVerifBadge(status) {
  const norm = normalizeAdminVerifStatus(status);
  if (norm === "APPROVED") return '<span class="badge badge-verified">APPROVED</span>';
  if (norm === "PENDING") return '<span class="badge badge-pending">PENDING</span>';
  if (norm === "NEEDS_REVISION") return '<span class="badge badge-pending">NEEDS_REVISION</span>';
  if (norm === "REJECTED") return '<span class="badge badge-alert">REJECTED</span>';
  return '<span class="badge badge-neutral">NOT_SUBMITTED</span>';
}

async function loadAdminVerifications() {
  try {
    // Use POST body for authenticated admin query (SEC-P0-5)
    const res = await API.post("admin_verifications", {
      id_token: getAuthToken(),
    });
    if (res.status === "ok") {
      const tbody = document.getElementById("verifTableBody");
      tbody.innerHTML = "";
      const items = res.items || [];
      const pendingCount = items.filter((i) => normalizeAdminVerifStatus(i.status) === "PENDING").length;
      document.getElementById("verifBadgeCount").innerText = pendingCount;

      if (items.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="9" style="text-align: center; color: var(--text-dim); padding: 24px;">Belum ada antrean verifikasi alumni.</td></tr>';
        return;
      }

      items.forEach((item) => {
        const tr = document.createElement("tr");
        const normStatus = normalizeAdminVerifStatus(item.status);
        const statusBadge = renderAdminVerifBadge(normStatus);
        const reviewHistory = item.reviewed_by
          ? `<div style="font-size: 11px; color: var(--text-sub);">Oleh: ${escapeAdmin(item.reviewed_by)}<br>${escapeAdmin(item.reviewed_at || "")}${item.reject_reason ? "<br>Catatan: " + escapeAdmin(item.reject_reason) : ""}</div>`
          : '<span style="font-size: 11px; color: var(--text-dim);">-</span>';

        const proofBtn = item.has_file
          ? `<button class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px;" onclick="viewVerificationProof('${escapeAdmin(item.verif_id)}')">Lihat Bukti</button>`
          : "";

        let reviewBtns = "";
        if (normStatus === "PENDING") {
          reviewBtns = `
            <button class="btn btn-success" style="font-size: 11px; padding: 4px 8px;" onclick="handleReview('${escapeAdmin(item.verif_id)}', 'APPROVED')">Setujui</button>
            <button class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px; border-color: #D97706; color: #92400E;" onclick="handleReview('${escapeAdmin(item.verif_id)}', 'NEEDS_REVISION')">Minta Revisi</button>
            <button class="btn btn-danger" style="font-size: 11px; padding: 4px 8px;" onclick="handleReview('${escapeAdmin(item.verif_id)}', 'REJECTED')">Tolak Final</button>
          `;
        }

        const actions = (proofBtn || reviewBtns)
          ? `<div style="display: flex; gap: 6px; flex-wrap: wrap;">${proofBtn}${reviewBtns}</div>`
          : "-";

        tr.innerHTML = `
          <td>${escapeAdmin(item.submitted_at || "-")}</td>
          <td><strong>${escapeAdmin(item.full_name)}</strong></td>
          <td>${escapeAdmin(item.email)}</td>
          <td><code style="font-family: var(--font-mono); font-size: 12px;">${escapeAdmin(item.nim)}</code></td>
          <td>${escapeAdmin(item.grad_year)}</td>
          <td>${escapeAdmin(item.faculty)}</td>
          <td>${statusBadge}</td>
          <td>${reviewHistory}</td>
          <td>${actions}</td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error("Error fetching verifications:", err);
  }
}

async function viewVerificationProof(verifId) {
  const modal = document.getElementById("proofPreviewModal");
  const body = document.getElementById("proofModalBody");
  const meta = document.getElementById("proofModalMeta");
  if (!modal || !body) return;

  modal.style.display = "flex";
  meta.innerText = "Memuat berkas privat dari Google Drive...";
  body.innerHTML = '<div style="padding: 40px; color: var(--text-dim);">Mengambil dokumen...</div>';

  try {
    const res = await API.post("admin_verif_proof", {
      id_token: getAuthToken(),
      verif_id: verifId,
    });

    if (res.status !== "ok" || !res.base64_data) {
      body.innerHTML = `<div style="color: #DC2626; padding: 24px;">${escapeAdmin(res.message || "Gagal memuat bukti dokumen.")}</div>`;
      return;
    }

    const mime = String(res.mime_type || "application/octet-stream");
    const safeMime = /^(image\/(png|jpeg|jpg)|application\/pdf)$/i.test(mime) ? mime : "application/octet-stream";
    const dataUri = `data:${safeMime};base64,${res.base64_data}`;
    meta.innerText = `Tiket: ${verifId} | Nama File: ${res.file_name || "-"} | MIME: ${safeMime}`;

    if (safeMime.indexOf("image/") === 0) {
      body.innerHTML = `<img src="${dataUri}" alt="Bukti Kelulusan" style="max-width: 100%; max-height: 60vh; border-radius: 6px;">`;
    } else if (safeMime === "application/pdf") {
      body.innerHTML = `<iframe src="${dataUri}" style="width: 100%; height: 60vh; border: none;" title="Bukti PDF"></iframe>`;
    } else {
      body.innerHTML = `<a href="${dataUri}" download="${escapeAdmin(res.file_name || "bukti_alumni")}" class="btn btn-primary">Unduh Berkas</a>`;
    }
  } catch (err) {
    body.innerHTML = `<div style="color: #DC2626; padding: 24px;">Error: ${escapeAdmin(err.message)}</div>`;
  }
}

function closeProofModal() {
  const modal = document.getElementById("proofPreviewModal");
  const body = document.getElementById("proofModalBody");
  if (modal) modal.style.display = "none";
  if (body) body.innerHTML = "";
}

async function handleReview(verifId, decision) {
  const normDecision = String(decision || "").toUpperCase();
  let reason = "";

  if (normDecision === "NEEDS_REVISION") {
    reason = prompt(
      "Masukkan catatan revisi untuk alumni (mis. scan buram / perlu melampirkan ijazah resmi):",
      "Dokumen belum terbaca jelas, silakan unggah ulang berkas PDF/JPG yang jelas.",
    );
    if (reason === null || !reason.trim()) return;
  } else if (normDecision === "REJECTED") {
    reason = prompt(
      "PERHATIAN: Keputusan REJECTED bersifat FINAL (alumni tidak dapat mengajukan ulang). Masukkan alasan penolakan:",
      "Data tidak sesuai catatan kelulusan alumni UPI.",
    );
    if (reason === null || !reason.trim()) return;
  } else if (normDecision === "APPROVED") {
    if (
      !confirm(
        "Setujui alumni ini? Sistem akan menerbitkan kode ID Unik Alumni (A000xxx) dan menghapus dokumen bukti dari Drive sesuai prinsip minimisasi data UU No. 27/2022.",
      )
    ) {
      return;
    }
  } else {
    return;
  }

  try {
    const res = await API.post("review_verification", {
      id_token: getAuthToken(),
      verif_id: verifId,
      decision: normDecision,
      reason: reason.trim(),
    });

    if (res.status === "ok") {
      const msg =
        normDecision === "APPROVED"
          ? `Alumni berhasil disetujui! Diterbitkan Ref Code: ${res.ref_code}`
          : normDecision === "NEEDS_REVISION"
            ? "Permintaan revisi dikirimkan kepada alumni."
            : "Pengajuan alumni ditolak secara final (REJECTED).";
      alert(msg);
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
    // Use POST body for authenticated admin query (SEC-P0-5)
    const res = await API.post("admin_queue", { id_token: getAuthToken() });
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
    // Use POST body for authenticated admin query (SEC-P0-5)
    const res = await API.post("admin_insights", { id_token: getAuthToken() });
    if (res.status === "ok") {
      document.getElementById("insightTotalAmount").innerText =
        res.formatted_net || res.formatted_total || "Rp 0";
      const grossEl = document.getElementById("insightTotalGross");
      const feeEl = document.getElementById("insightTotalFee");
      if (grossEl) grossEl.innerText = res.formatted_gross || res.formatted_total || "Rp 0";
      if (feeEl) feeEl.innerText = res.formatted_fee || "Rp 0";
      document.getElementById("insightTotalCount").innerText =
        `${res.total_count || 0} Transaksi`;
      document.getElementById("insightVerifiedAlumni").innerText =
        `${(res.demographics && res.demographics.verified_alumni) || 0} Alumni`;

      const t = res.tier_distribution || {};
      const ch = res.channel_breakdown || {};
      let chHtml = "";
      for (const [channel, amt] of Object.entries(ch)) {
        chHtml += `<div>&bull; <strong>Kanal ${escapeAdmin(channel)}:</strong> Rp ${Number(amt).toLocaleString("id-ID")}</div>`;
      }
      document.getElementById("tierInsightBox").innerHTML = `
        <div>&bull; <strong>Tier 1 (Ref Code Manual):</strong> ${t["1"] || 0}</div>
        <div>&bull; <strong>Tier 1-MIDTRANS (Snap Gateway):</strong> ${t["1-MIDTRANS"] || 0}</div>
        <div>&bull; <strong>Tier 2 (Bank + Nominal):</strong> ${t["2"] || 0}</div>
        <div>&bull; <strong>Tier 3 (Unmatched Queue):</strong> ${t["3"] || 0}</div>
        <div>&bull; <strong>Tautan Manual Admin:</strong> ${t["MANUAL"] || 0}</div>
        ${chHtml}
      `;

      const b = res.bank_breakdown || {};
      const p = res.program_breakdown || {};
      let bHtml = "";
      for (const [bank, amount] of Object.entries(b)) {
        bHtml += `<div>&bull; <strong>${escapeAdmin(bank)}:</strong> Rp ${Number(amount).toLocaleString("id-ID")}</div>`;
      }
      for (const [prog, amount] of Object.entries(p)) {
        bHtml += `<div>&bull; <em>${escapeAdmin(prog)}:</em> Rp ${Number(amount).toLocaleString("id-ID")}</div>`;
      }
      document.getElementById("bankInsightBox").innerHTML =
        bHtml || "Belum ada transaksi terkonfirmasi.";
    }
  } catch (err) {
    console.error("Error fetching admin insights:", err);
  }
}

async function loadAdminTransactions() {
  const tbody = document.getElementById("adminTxTableBody");
  const pendingBody = document.getElementById("pendingMidtransTableBody");
  if (!tbody) return;

  const channelFilter = (document.getElementById("txFilterChannel") || {}).value || "";
  const statusFilter = (document.getElementById("txFilterStatus") || {}).value || "";

  try {
    const res = await API.post("admin_transactions", {
      id_token: getAuthToken(),
      filters: {
        channel: channelFilter,
        status: statusFilter,
      },
    });
    if (res.status !== "ok") {
      tbody.innerHTML = `<tr><td colspan="8" style="color: #DC2626; padding: 16px;">${escapeAdmin(res.message || "Gagal memuat transaksi.")}</td></tr>`;
      return;
    }

    if (pendingBody) {
      const pendingList = res.pending_midtrans_intents || [];
      if (pendingList.length === 0) {
        pendingBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 12px;">Belum ada intent Midtrans Snap PENDING.</td></tr>';
      } else {
        pendingBody.innerHTML = pendingList
          .map((p) => `
            <tr>
              <td><code style="font-family: var(--font-mono); font-size: 11px;">${escapeAdmin(p.order_id)}</code></td>
              <td><code>${escapeAdmin(p.ref_code)}</code></td>
              <td><strong>${escapeAdmin(p.formatted_amount)}</strong></td>
              <td>${escapeAdmin(p.program)}</td>
              <td style="font-size: 11px;">${escapeAdmin(p.created_at)}</td>
              <td>
                <button type="button" class="btn btn-primary" style="font-size: 11px; padding: 4px 10px;" onclick="handleAdminSyncMidtrans('${escapeAdmin(p.intent_id)}')">
                  Sinkronkan Status
                </button>
              </td>
            </tr>
          `)
          .join("");
      }
    }

    cachedAdminTransactions = res.items || [];
    if (cachedAdminTransactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 20px;">Tidak ada transaksi yang sesuai filter.</td></tr>';
      return;
    }

    tbody.innerHTML = cachedAdminTransactions
      .map((tx) => {
        const receiptCell = tx.receipt_no
          ? `<a href="receipt.html#tx=${encodeURIComponent(tx.tx_id)}" style="font-family: var(--font-mono); font-weight: 700; color: var(--crimson-800); text-decoration: underline;">${escapeAdmin(tx.receipt_no)}</a>`
          : `<span style="color: var(--text-dim); font-size: 11px;">Belum terbit</span>`;
        const statusText = `${escapeAdmin(tx.match_status)} / ${escapeAdmin(tx.gateway_status || "-")}`;
        const emailCell =
          tx.email_status === "FAILED"
            ? `<span class="badge badge-alert" title="${escapeAdmin(tx.email_error || "")}">FAILED</span>`
            : `<span class="badge badge-neutral">${escapeAdmin(tx.email_status || "-")}</span>`;
        const canRetryEmail =
          Boolean(tx.receipt_no) &&
          (tx.email_status === "FAILED" || tx.email_status === "PENDING") &&
          tx.gateway_status !== "REFUNDED" &&
          tx.gateway_status !== "PARTIAL_REFUNDED" &&
          tx.gateway_status !== "CHARGEBACK";
        const actionBtn = canRetryEmail
          ? `<button type="button" class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px;" onclick="handleRetryTxEmail('${escapeAdmin(tx.tx_id)}')">Kirim Ulang Email</button>`
          : tx.receipt_no
          ? `<a href="receipt.html#tx=${encodeURIComponent(tx.tx_id)}" class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px; text-decoration: none;">Kuitansi</a>`
          : "-";

        return `
          <tr>
            <td>
              <div style="font-family: var(--font-mono); font-size: 11px;">${escapeAdmin(tx.tx_id)}</div>
              <div>${receiptCell}</div>
            </td>
            <td>
              <div>${escapeAdmin(tx.donor_name || "-")}</div>
              <code style="font-size: 11px;">${escapeAdmin(tx.ref_code || "-")}</code>
            </td>
            <td>
              <div><strong>${escapeAdmin(tx.payment_channel)}</strong></div>
              <div style="font-size: 11px; color: var(--text-sub);">${escapeAdmin(tx.bank)}</div>
            </td>
            <td>${escapeAdmin(tx.program)}</td>
            <td style="font-family: var(--font-mono); font-size: 11px;">
              <div>Gross: Rp ${Number(tx.gross_amount || 0).toLocaleString("id-ID")}</div>
              <div>Fee: Rp ${Number(tx.gateway_fee || 0).toLocaleString("id-ID")}</div>
              <div style="font-weight: 700; color: #047857;">Net: Rp ${Number(tx.net_amount || 0).toLocaleString("id-ID")}</div>
            </td>
            <td style="font-size: 11px;">${statusText}</td>
            <td>${emailCell}</td>
            <td>${actionBtn}</td>
          </tr>
        `;
      })
      .join("");
  } catch (err) {
    console.error("Error loading admin transactions:", err);
  }
}

async function handleAdminSyncMidtrans(intentId) {
  try {
    const res = await API.post("admin_check_midtrans", {
      id_token: getAuthToken(),
      intent_id: intentId,
    });
    if (res.status === "ok") {
      alert(`Sinkronisasi selesai: Status Intent = ${res.intent_status}, Gateway = ${res.gateway_status}`);
      await loadAdminTransactions();
      await loadAdminInsights();
    } else {
      alert("Gagal sinkronisasi Midtrans: " + (res.message || "Error"));
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function handleRetryTxEmail(txId) {
  try {
    const res = await API.post("retry_tx_email", {
      id_token: getAuthToken(),
      tx_id: txId,
    });
    if (res.status === "ok") {
      alert(`Status email diperbarui: ${res.email_status}`);
      await loadAdminTransactions();
    } else {
      alert("Gagal kirim ulang email: " + (res.message || "Error"));
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

function escapeCsvCell_(val) {
  let str = String(val === undefined || val === null ? "" : val);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  return '"' + str.replace(/"/g, '""') + '"';
}

async function exportAdminFinancialCsv() {
  if (!cachedAdminTransactions || cachedAdminTransactions.length === 0) {
    await loadAdminTransactions();
  }
  const headers = [
    "tx_id",
    "receipt_no",
    "date",
    "ref_code",
    "payment_channel",
    "bank",
    "program",
    "gross_amount",
    "gateway_fee",
    "net_amount",
    "match_status",
    "gateway_status",
    "email_status",
  ];
  const lines = [headers.join(",")];
  cachedAdminTransactions.forEach((tx) => {
    lines.push(headers.map((h) => escapeCsvCell_(tx[h])).join(","));
  });

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "laporan_donasi_ika_upi.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function loadAdminAuditLogs(offset) {
  const tbody = document.getElementById("auditLogTableBody");
  const pagerInfo = document.getElementById("auditLogPagerInfo");
  if (!tbody) return;

  adminAuditOffset = Math.max(0, parseInt(offset, 10) || 0);
  try {
    const res = await API.post("admin_audit_logs", {
      id_token: getAuthToken(),
      limit: adminAuditLimit,
      offset: adminAuditOffset,
    });
    if (res.status !== "ok") {
      tbody.innerHTML = `<tr><td colspan="5" style="color: #DC2626; padding: 16px;">${escapeAdmin(res.message || "Gagal memuat audit log.")}</td></tr>`;
      return;
    }

    const items = res.items || [];
    const total = res.total || 0;
    if (pagerInfo) {
      const startDisp = total === 0 ? 0 : adminAuditOffset + 1;
      const endDisp = Math.min(total, adminAuditOffset + items.length);
      pagerInfo.innerText = `Menampilkan ${startDisp}–${endDisp} dari total ${total} entri audit log.`;
    }

    const prevBtn = document.getElementById("btnAuditPrev");
    const nextBtn = document.getElementById("btnAuditNext");
    if (prevBtn) prevBtn.disabled = adminAuditOffset <= 0;
    if (nextBtn) nextBtn.disabled = adminAuditOffset + adminAuditLimit >= total;

    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 20px;">Belum ada entri audit log.</td></tr>';
      return;
    }

    tbody.innerHTML = items
      .map((entry) => `
        <tr>
          <td style="font-family: var(--font-mono); font-size: 11px;">${escapeAdmin(entry.timestamp)}</td>
          <td style="font-size: 12px;">${escapeAdmin(entry.actor_email)}</td>
          <td><span class="badge badge-neutral">${escapeAdmin(entry.action)}</span></td>
          <td style="font-family: var(--font-mono); font-size: 11px;">${escapeAdmin(entry.target)}</td>
          <td style="font-size: 12px; color: var(--text-sub);">${escapeAdmin(entry.detail)}</td>
        </tr>
      `)
      .join("");
  } catch (err) {
    console.error("Error loading audit logs:", err);
  }
}

async function loadAdminPrograms() {
  const tbody = document.getElementById("programsTableBody");
  if (!tbody) return;
  try {
    const res = await API.post("admin_programs", { id_token: getAuthToken() });
    if (res.status !== "ok") {
      tbody.innerHTML = `<tr><td colspan="6" style="color: #DC2626; padding: 16px;">${escapeAdmin(res.message || "Gagal memuat daftar program.")}</td></tr>`;
      return;
    }

    const list = res.programs || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 20px;">Belum ada data program.</td></tr>';
      return;
    }

    tbody.innerHTML = "";
    list.forEach((p) => {
      const tr = document.createElement("tr");
      const statusBadge = p.is_active
        ? '<span class="badge badge-verified">AKTIF</span>'
        : '<span class="badge badge-neutral">NONAKTIF</span>';
      const toggleLabel = p.is_active ? "Nonaktifkan" : "Aktifkan";
      const safeId = escapeAdmin(p.program_id);
      const safeName = escapeAdmin(p.name);
      const safeDesc = escapeAdmin(p.description || "");

      tr.innerHTML = `
        <td><code>${safeId}</code></td>
        <td><strong>${safeName}</strong></td>
        <td style="font-size: 12px; color: var(--text-sub);">${safeDesc || "-"}</td>
        <td>${statusBadge}</td>
        <td>${Number(p.usage_count) || 0}x</td>
        <td>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px;" data-pid="${safeId}" data-name="${safeName}" data-desc="${safeDesc}" data-active="${p.is_active ? "1" : "0"}" onclick="editProgramFromButton(this)">Edit</button>
            <button type="button" class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px;" onclick="handleToggleProgram('${safeId}', ${!p.is_active})">${toggleLabel}</button>
            <button type="button" class="btn btn-danger" style="font-size: 11px; padding: 4px 8px;" onclick="handleDeleteProgram('${safeId}')">Hapus</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Error loading programs:", err);
  }
}

function editProgramFromButton(btn) {
  document.getElementById("programEditId").value = btn.getAttribute("data-pid") || "";
  document.getElementById("programNameInput").value = btn.getAttribute("data-name") || "";
  document.getElementById("programDescInput").value = btn.getAttribute("data-desc") || "";
  document.getElementById("programActiveCheck").checked = btn.getAttribute("data-active") === "1";
  document.getElementById("btnSaveProgram").innerText = "Simpan Perubahan";
}

function resetProgramForm() {
  document.getElementById("programEditId").value = "";
  document.getElementById("programNameInput").value = "";
  document.getElementById("programDescInput").value = "";
  document.getElementById("programActiveCheck").checked = true;
  document.getElementById("btnSaveProgram").innerText = "Tambah Program";
}

async function handleSaveProgram(e) {
  e.preventDefault();
  const editId = document.getElementById("programEditId").value.trim();
  const name = document.getElementById("programNameInput").value.trim();
  const description = document.getElementById("programDescInput").value.trim();
  const isActive = document.getElementById("programActiveCheck").checked;

  try {
    const res = await API.post("save_program", {
      id_token: getAuthToken(),
      mode: editId ? "update" : "create",
      program_id: editId || undefined,
      name: name,
      description: description,
      is_active: isActive,
    });
    if (res.status === "ok") {
      alert(editId ? "Program berhasil diperbarui." : `Program baru dibuat (${res.program.program_id}).`);
      resetProgramForm();
      await loadAdminPrograms();
    } else {
      alert("Gagal menyimpan program: " + (res.message || "Error"));
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function handleToggleProgram(programId, nextActive) {
  try {
    const res = await API.post("save_program", {
      id_token: getAuthToken(),
      mode: "toggle",
      program_id: programId,
      is_active: nextActive,
    });
    if (res.status === "ok") {
      await loadAdminPrograms();
    } else {
      alert("Gagal mengubah status program: " + (res.message || "Error"));
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function handleDeleteProgram(programId) {
  if (!confirm(`Hapus program ${programId}? Penghapusan akan ditolak otomatis jika program sudah memiliki histori transaksi.`)) {
    return;
  }
  try {
    const res = await API.post("delete_program", {
      id_token: getAuthToken(),
      program_id: programId,
    });
    if (res.status === "ok") {
      alert("Program berhasil dihapus.");
      await loadAdminPrograms();
    } else {
      alert("Gagal menghapus program: " + (res.message || "Error"));
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

function escapeAdmin(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

document.addEventListener("DOMContentLoaded", initAdminPortal);
