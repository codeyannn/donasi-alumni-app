/**
 * Notifier.gs
 * Email notification dispatchers for Donors and Administrators.
 */

/**
 * Sends a confirmation email to the donor when their donation is confirmed.
 *
 * @param {Object} data - {to_email, full_name, ref_code, amount, bank, date, program}
 */
function sendDonorDonationReceivedEmail_(data) {
  if (!data.to_email) return;

  try {
    const orgName =
      getConfig_("ORG_NAME") || "Pengelola Beasiswa Ikatan Alumni UPI";
    const formattedAmount = formatRupiah(data.amount);
    const subject = `[TERIMA KASIH] Donasi ${formattedAmount} Berhasil Diverifikasi (${orgName})`;

    const htmlBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1E293B; border: 1px solid #E2E8F0; border-radius: 8px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #1E3A8A 0%, #2563EB 100%); padding: 24px; color: #FFFFFF;">
          <h2 style="margin: 0 0 6px 0; font-size: 20px;">Konfirmasi Penerimaan Donasi</h2>
          <p style="margin: 0; font-size: 14px; opacity: 0.9;">${escapeHtml_(orgName)}</p>
        </div>
        <div style="padding: 24px;">
          <p style="font-size: 15px; margin-top: 0;">
            Halo <strong>${escapeHtml_(data.full_name || "Alumni UPI")}</strong>,
          </p>
          <p style="font-size: 14px; line-height: 1.6;">
            Alhamdulillah, dana donasi Anda telah kami terima dan diverifikasi secara otomatis melalui mutasi bank. Terima kasih banyak atas kontribusi Anda bagi masa depan pendidikan adik-adik mahasiswa UPI!
          </p>

          <div style="background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 18px; margin: 20px 0;">
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 6px 0; color: #64748B;">ID Donatur:</td>
                <td style="padding: 6px 0; font-weight: bold; color: #1E293B;">${escapeHtml_(data.ref_code)}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748B;">Nominal Donasi:</td>
                <td style="padding: 6px 0; font-weight: bold; color: #047857; font-size: 16px;">${formattedAmount}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748B;">Bank Tujuan:</td>
                <td style="padding: 6px 0; font-weight: bold;">${escapeHtml_(data.bank)}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748B;">Alokasi Program:</td>
                <td style="padding: 6px 0; color: #4338CA; font-weight: bold;">${escapeHtml_(data.program)}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748B;">Waktu Transaksi:</td>
                <td style="padding: 6px 0;">${escapeHtml_(data.date)}</td>
              </tr>
            </table>
          </div>

          <p style="font-size: 13px; color: #64748B; line-height: 1.5;">
            Bukti tanda terima ini sah dan dicatat secara transparan di dalam sistem penghimpunan dana beasiswa IKA UPI. Anda dapat melihat riwayat donasi lengkap di dasbor aplikasi.
          </p>
        </div>
      </div>
    `;

    MailApp.sendEmail({
      to: data.to_email,
      subject: subject,
      htmlBody: htmlBody,
    });
  } catch (err) {
    Logger.log("Could not send donor email: " + err.message);
  }
}

/**
 * Sends real-time alert email to system administrators when mutations arrive.
 *
 * @param {Array<Object>} alerts - Array of incoming transaction metrics.
 */
function sendAdminDonationAlert_(alerts) {
  try {
    const adminEmailsRaw = getConfig_("ADMIN_EMAILS") || "maulanaa1408@upi.edu";
    const emailList = adminEmailsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (emailList.length === 0) return;

    const orgName =
      getConfig_("ORG_NAME") || "Pengelola Beasiswa Ikatan Alumni UPI";
    const totalAmount = alerts.reduce((s, a) => s + (a.amount || 0), 0);
    const formattedTotal = formatRupiah(totalAmount);

    let rowsHtml = "";
    for (let i = 0; i < alerts.length; i++) {
      const a = alerts[i];
      const statusBadge =
        a.status === "MATCHED"
          ? '<span style="background-color: #D1FAE5; color: #065F46; padding: 2px 6px; border-radius: 4px; font-weight: bold;">MATCHED (T' +
            a.tier +
            ")</span>"
          : '<span style="background-color: #FEE2E2; color: #991B1B; padding: 2px 6px; border-radius: 4px; font-weight: bold;">UNMATCHED</span>';

      rowsHtml += `
        <tr>
          <td style="padding: 8px 10px; border: 1px solid #E2E8F0; font-size: 13px;">${escapeHtml_(a.bank)}</td>
          <td style="padding: 8px 10px; border: 1px solid #E2E8F0; font-size: 13px; font-weight: bold;">${formatRupiah(a.amount)}</td>
          <td style="padding: 8px 10px; border: 1px solid #E2E8F0; font-size: 13px;">${escapeHtml_(a.donor)}</td>
          <td style="padding: 8px 10px; border: 1px solid #E2E8F0; font-size: 13px; font-family: monospace;">${escapeHtml_(a.ref_code)}</td>
          <td style="padding: 8px 10px; border: 1px solid #E2E8F0; font-size: 12px;">${statusBadge}</td>
        </tr>
      `;
    }

    const htmlBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 650px; margin: 0 auto; color: #1E293B;">
        <h3 style="color: #1E3A8A; margin-bottom: 4px;">[NOTIFIKASI DANA MASUK] ${alerts.length} Mutasi Baru</h3>
        <p style="font-size: 13px; color: #64748B; margin-top: 0;">${escapeHtml_(orgName)} • Real-time Webhook Listener</p>
        <p style="font-size: 14px;">Total mutasi batch: <strong>${formattedTotal}</strong></p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <thead>
            <tr style="background-color: #F1F5F9; text-align: left; font-size: 12px; color: #475569;">
              <th style="padding: 8px 10px; border: 1px solid #CBD5E1;">Bank</th>
              <th style="padding: 8px 10px; border: 1px solid #CBD5E1;">Nominal</th>
              <th style="padding: 8px 10px; border: 1px solid #CBD5E1;">Nama Masked</th>
              <th style="padding: 8px 10px; border: 1px solid #CBD5E1;">Kode Donatur</th>
              <th style="padding: 8px 10px; border: 1px solid #CBD5E1;">Status Match</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
        <p style="font-size: 12px; color: #64748B;">Pengelola menerima notifikasi real-time tanpa perlu meminta login internet banking bendahara.</p>
      </div>
    `;

    for (let j = 0; j < emailList.length; j++) {
      MailApp.sendEmail({
        to: emailList[j],
        subject: `[DANA MASUK] ${alerts.length} Mutasi Baru - Total ${formattedTotal}`,
        htmlBody: htmlBody,
      });
    }
  } catch (err) {
    Logger.log("Could not send admin alert email: " + err.message);
  }
}

/**
 * Notifies admin when a new alumni verification request is submitted.
 */
function sendAdminNewVerificationAlert_(user, verifId, data) {
  try {
    const adminEmailsRaw = getConfig_("ADMIN_EMAILS") || "maulanaa1408@upi.edu";
    const emailList = adminEmailsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (emailList.length === 0) return;

    const htmlBody = `
      <div style="font-family: sans-serif; max-width: 500px; color: #1E293B;">
        <h3 style="color: #1E3A8A;">Pengajuan Verifikasi Alumni Baru</h3>
        <p>Ada pengajuan alumni baru yang perlu ditinjau di dasbor admin:</p>
        <ul>
          <li><strong>Nama:</strong> ${escapeHtml_(user.full_name)}</li>
          <li><strong>Email:</strong> ${escapeHtml_(user.email)}</li>
          <li><strong>NIM:</strong> ${escapeHtml_(data.nim)}</li>
          <li><strong>Tahun Lulus:</strong> ${escapeHtml_(data.grad_year)}</li>
          <li><strong>Fakultas:</strong> ${escapeHtml_(data.faculty)}</li>
        </ul>
        <p>Buka dasbor admin untuk memverifikasi dokumen bukti kelulusan.</p>
      </div>
    `;

    for (let i = 0; i < emailList.length; i++) {
      MailApp.sendEmail({
        to: emailList[i],
        subject: `[VERIFIKASI ALUMNI] Pengajuan Baru: ${user.full_name} (${data.nim})`,
        htmlBody: htmlBody,
      });
    }
  } catch (e) {
    Logger.log("Admin verif alert error: " + e.message);
  }
}

/**
 * Sends approval email to alumnus with their newly minted ID.
 */
function sendAlumniVerifiedEmail_(email, name, refCode) {
  try {
    const orgName =
      getConfig_("ORG_NAME") || "Pengelola Beasiswa Ikatan Alumni UPI";
    const htmlBody = `
      <div style="font-family: sans-serif; max-width: 500px; color: #1E293B;">
        <h2 style="color: #047857;">Selamat! Verifikasi Alumni Disetujui</h2>
        <p>Halo <strong>${escapeHtml_(name)}</strong>,</p>
        <p>Dokumen kelulusan Anda di Universitas Pendidikan Indonesia telah berhasil diverifikasi oleh admin.</p>
        <div style="background-color: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <div style="font-size: 13px; color: #065F46;">Kode ID Unik Alumni Anda:</div>
          <div style="font-size: 26px; font-weight: bold; color: #065F46; letter-spacing: 2px;">${escapeHtml_(refCode)}</div>
        </div>
        <p style="font-size: 14px; line-height: 1.5;">
          Gunakan kode ini saat mentransfer donasi beasiswa alumni agar setiap kontribusi Anda tercatat otomatis atas nama Anda di database alumni.
        </p>
      </div>
    `;

    MailApp.sendEmail({
      to: email,
      subject: `[VERIFIKASI DISETUJUI] Kode ID Alumni Anda: ${refCode} - ${orgName}`,
      htmlBody: htmlBody,
    });
  } catch (e) {
    Logger.log("Alumni verified email error: " + e.message);
  }
}

/**
 * Sends rejection notification email to user.
 */
function sendAlumniRejectedEmail_(email, name, reason) {
  try {
    const htmlBody = `
      <div style="font-family: sans-serif; max-width: 500px; color: #1E293B;">
        <h3 style="color: #DC2626;">Pemberitahuan Status Verifikasi Alumni</h3>
        <p>Halo ${escapeHtml_(name)},</p>
        <p>Mohon maaf, pengajuan verifikasi alumni Anda belum dapat kami setujui karena:</p>
        <blockquote style="background-color: #F8FAFC; border-left: 4px solid #DC2626; padding: 10px; margin: 12px 0;">
          ${escapeHtml_(reason || "Dokumen bukti tidak sesuai dengan catatan alumni UPI.")}
        </blockquote>
        <p>Anda dapat mengunggah kembali dokumen bukti yang valid (Ijazah / SKL / Kartu Alumni) melalui aplikasi.</p>
      </div>
    `;

    MailApp.sendEmail({
      to: email,
      subject: "[VERIFIKASI DITOLAK] Perlu Perbaikan Bukti Alumni UPI",
      htmlBody: htmlBody,
    });
  } catch (e) {
    Logger.log("Alumni rejected email error: " + e.message);
  }
}

/**
 * Helper to escape HTML characters.
 */
function escapeHtml_(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
