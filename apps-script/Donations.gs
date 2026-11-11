/**
 * Donations.gs
 * Intent creation, intent expiry, user personal donation history, and manual matching by admin.
 */

/**
 * Creates a donation intent for a user.
 * 
 * @param {string} idToken - User auth token.
 * @param {Object} data - {amount, bank, program, is_anonymous}
 * @returns {Object} Intent details with transfer reference instructions.
 */
function createDonationIntent(idToken, data) {
  const profile = verifyIdToken(idToken);
  const user = findUserByEmail_(profile.email);
  if (!user) throw new Error('Pengguna belum terdaftar.');

  const amount = parseFloat(data.amount);
  if (isNaN(amount) || amount < 10000) {
    throw new Error('Nominal donasi minimal Rp 10.000.');
  }

  const bank = String(data.bank || '').toUpperCase().trim();
  if (SUPPORTED_BANKS.indexOf(bank) === -1) {
    throw new Error('Bank tidak didukung. Pilihan: ' + SUPPORTED_BANKS.join(', '));
  }

  const program = String(data.program || 'Beasiswa Alumni UPI').trim();
  const isAnon = data.is_anonymous ? 'YES' : 'NO';

  // If alumni, user must be verified to have an A000xxx ref_code
  let refCode = user.ref_code;
  if (!refCode) {
    if (user.role === 'ALUMNI') {
      throw new Error('Akun Alumni Anda belum terverifikasi oleh admin. Mohon selesaikan pengajuan verifikasi.');
    } else {
      // Fallback for guest if somehow missing
      const seq = getNextCounterValue_('GUEST');
      refCode = formatRefCode('G', seq);
      updateUserVerificationStatus_(user.user_id, 'NONE', refCode);
    }
  }

  const now = new Date();
  const windowHours = parseInt(getConfig_('MATCH_WINDOW_HOURS') || '24', 10);
  const expiresAt = new Date(now.getTime() + windowHours * 60 * 60 * 1000);

  const intentId = 'INT_' + Utilities.getUuid().substring(0, 8);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);

  intentSheet.appendRow([
    intentId,
    user.user_id,
    refCode,
    amount,
    bank,
    program,
    'PENDING',
    now.toISOString(),
    expiresAt.toISOString(),
    '' // matched_tx_id
  ]);

  logAudit_(user.email, 'CREATE_INTENT', intentId, bank + ' ' + amount + ' Ref: ' + refCode);

  return {
    status: 'ok',
    intent_id: intentId,
    ref_code: refCode,
    bank: bank,
    amount: amount,
    program: program,
    formatted_amount: formatRupiah(amount),
    expires_at: expiresAt.toISOString(),
    transfer_instruction: {
      target_bank: bank,
      amount: amount,
      transfer_note: refCode,
      note_instruction: 'PENTING: Tuliskan kode referensi "' + refCode + '" pada kolom berita/keterangan transfer m-banking Anda agar donasi terverifikasi instan.'
    }
  };
}

/**
 * Retrieves the logged-in user's personal donation history and stats.
 * 
 * @param {string} idToken - User auth token.
 * @returns {Object} Personal donation stats and transaction history.
 */
function getMyDonations(idToken) {
  const profile = verifyIdToken(idToken);
  const user = findUserByEmail_(profile.email);
  if (!user) throw new Error('Pengguna tidak ditemukan.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);

  const history = [];
  let myTotalDonated = 0;
  let myTxCount = 0;
  const bankBreakdown = {};

  // 1. Gather confirmed transactions
  if (txSheet && txSheet.getLastRow() > 1) {
    const txData = txSheet.getRange(2, 1, txSheet.getLastRow() - 1, 17).getValues();
    for (let i = 0; i < txData.length; i++) {
      const row = txData[i];
      // Match by user_id or ref_code
      if ((user.user_id && row[12] === user.user_id) || (user.ref_code && row[13] === user.ref_code)) {
        const amt = parseFloat(row[6]) || 0;
        const b = String(row[3] || 'UNKNOWN').trim();
        myTotalDonated += amt;
        myTxCount++;
        bankBreakdown[b] = (bankBreakdown[b] || 0) + amt;

        history.push({
          type: 'TRANSACTION',
          id: row[0],
          date: row[5] || row[2],
          bank: b,
          amount: amt,
          formatted_amount: formatRupiah(amt),
          program: row[15] || 'Umum',
          match_status: row[10],
          ref_code: row[13]
        });
      }
    }
  }

  // 2. Gather active pending intents
  const pendingIntents = [];
  if (intentSheet && intentSheet.getLastRow() > 1) {
    const itData = intentSheet.getRange(2, 1, intentSheet.getLastRow() - 1, 10).getValues();
    for (let j = 0; j < itData.length; j++) {
      const it = itData[j];
      if (it[1] === user.user_id && it[6] === 'PENDING') {
        pendingIntents.push({
          intent_id: it[0],
          ref_code: it[2],
          amount: it[3],
          formatted_amount: formatRupiah(it[3]),
          bank: it[4],
          program: it[5],
          created_at: it[7],
          expires_at: it[8]
        });
      }
    }
  }

  return {
    status: 'ok',
    user: {
      user_id: user.user_id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      ref_code: user.ref_code,
      verification_status: user.verification_status
    },
    summary: {
      total_donated: myTotalDonated,
      formatted_total: formatRupiah(myTotalDonated),
      total_count: myTxCount,
      by_bank: bankBreakdown
    },
    active_intents: pendingIntents,
    history: history.reverse()
  };
}

/**
 * Periodic trigger function to expire stale pending donation intents older than MATCH_WINDOW_HOURS.
 */
function expireStaleIntents() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (!sheet || sheet.getLastRow() <= 1) return;

  const now = new Date();
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();

  for (let i = 0; i < data.length; i++) {
    const status = data[i][6];
    const expiresAt = new Date(data[i][8]);
    if (status === 'PENDING' && expiresAt < now) {
      sheet.getRange(i + 2, 7).setValue('EXPIRED');
    }
  }
}

