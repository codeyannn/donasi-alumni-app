/**
 * Donations.gs
 * Intent creation, intent expiry, user personal donation history, status polling, and payment simulation.
 */

/**
 * Creates a donation intent for a user, generating dedicated Virtual Account & QRIS string.
 * 
 * @param {string} idToken - User auth token.
 * @param {Object} data - {amount, bank, program, is_anonymous}
 * @returns {Object} Intent details with transfer reference, Virtual Account, & QRIS.
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

  let refCode = user.ref_code;
  if (!refCode) {
    if (user.role === 'ALUMNI') {
      throw new Error('Akun Alumni Anda belum terverifikasi oleh admin. Mohon selesaikan pengajuan verifikasi.');
    } else {
      const seq = getNextCounterValue_('GUEST');
      refCode = formatRefCode('G', seq);
      updateUserVerificationStatus_(user.user_id, 'NONE', refCode);
    }
  }

  // Generate Bank-specific Virtual Account
  const vaInfo = generateVirtualAccount(bank, refCode);

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

  logAudit_(user.email, 'CREATE_INTENT', intentId, bank + ' ' + amount + ' VA: ' + vaInfo.va_number);

  // Dynamic QRIS string payload (QRIS Static/Dynamic Merchant Specification)
  const qrisString = `00020101021226670016ID.GO.BI.QRIS011893600999000000010215${vaInfo.va_number}52048398530336054${String(amount).padStart(2,'0')}5802ID5923BEASISWA IKATAN ALUMNI6007BANDUNG62170113${intentId}6304ABCD`;

  return {
    status: 'ok',
    intent_id: intentId,
    ref_code: refCode,
    bank: bank,
    amount: amount,
    program: program,
    formatted_amount: formatRupiah(amount),
    expires_at: expiresAt.toISOString(),
    virtual_account: {
      bank: bank,
      bank_prefix: vaInfo.bank_prefix,
      va_number: vaInfo.va_number,
      va_formatted: vaInfo.va_formatted,
      account_name: 'BEASISWA IKA UPI - ' + (user.full_name || 'ALUMNI')
    },
    qris: {
      merchant_name: 'BEASISWA IKA UPI',
      qris_payload: qrisString,
      amount: amount
    },
    transfer_instruction: {
      target_bank: bank,
      amount: amount,
      transfer_note: refCode,
      note_instruction: 'PENTING: Salin nomor Virtual Account di atas atau scan QRIS melalui m-banking/e-wallet Anda.'
    }
  };
}

/**
 * Checks the status of a specific intent (called every 5 seconds by frontend real-time poller).
 * 
 * @param {string} idToken - User auth token.
 * @param {string} intentId - Target intent ID.
 * @returns {Object} Current status ('PENDING' or 'MATCHED') + transaction details if matched.
 */
function checkIntentStatus(idToken, intentId) {
  if (!intentId) throw new Error('Missing intent_id parameter.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (!intentSheet || intentSheet.getLastRow() <= 1) {
    return { status: 'ok', intent_status: 'NOT_FOUND' };
  }

  const data = intentSheet.getRange(2, 1, intentSheet.getLastRow() - 1, 10).getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] === intentId) {
      const intentStatus = data[i][6];
      const matchedTxId = data[i][9];
      return {
        status: 'ok',
        intent_id: intentId,
        intent_status: intentStatus, // PENDING, MATCHED, EXPIRED
        matched_tx_id: matchedTxId || null
      };
    }
  }

  return { status: 'ok', intent_status: 'NOT_FOUND' };
}

/**
 * Triggers instant payment simulation for live demo presentations.
 * Mimics bank webhook execution for the given intent.
 * 
 * @param {string} idToken - User auth token.
 * @param {string} intentId - Target intent ID.
 * @returns {Object} Webhook processing result.
 */
function simulateIntentPayment(idToken, intentId) {
  const profile = verifyIdToken(idToken);
  const user = findUserByEmail_(profile.email);
  if (!user) throw new Error('User not found.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  const data = intentSheet.getRange(2, 1, intentSheet.getLastRow() - 1, 10).getValues();

  let targetIntent = null;
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] === intentId) {
      targetIntent = {
        intent_id: data[i][0],
        user_id: data[i][1],
        ref_code: data[i][2],
        amount: data[i][3],
        bank: data[i][4],
        program: data[i][5],
        status: data[i][6]
      };
      break;
    }
  }

  if (!targetIntent) throw new Error('Intent not found.');
  if (targetIntent.status === 'MATCHED') return { status: 'ok', message: 'Already paid' };

  // Generate realistic VA narration
  const vaInfo = generateVirtualAccount(targetIntent.bank, targetIntent.ref_code);
  const fakeMutation = {
    mutation_id: 'SIM_' + targetIntent.bank + '_' + Date.now().toString().slice(-6),
    bank: targetIntent.bank,
    amount: targetIntent.amount,
    type: 'CR',
    description: `PEMBAYARAN VA ${vaInfo.va_number} AN ${user.full_name.toUpperCase()} BEASISWA`,
    transaction_date: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss')
  };

  // Dispatch into webhook processor
  const result = handleWebhookMutations_([fakeMutation]);
  return {
    status: 'ok',
    message: 'Simulated payment processed successfully',
    mutation: fakeMutation,
    result: result
  };
}

/**
 * Retrieves the logged-in user's personal donation history and stats.
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

  if (txSheet && txSheet.getLastRow() > 1) {
    const txData = txSheet.getRange(2, 1, txSheet.getLastRow() - 1, 17).getValues();
    for (let i = 0; i < txData.length; i++) {
      const row = txData[i];
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

  const pendingIntents = [];
  if (intentSheet && intentSheet.getLastRow() > 1) {
    const itData = intentSheet.getRange(2, 1, intentSheet.getLastRow() - 1, 10).getValues();
    for (let j = 0; j < itData.length; j++) {
      const it = itData[j];
      if (it[1] === user.user_id && it[6] === 'PENDING') {
        const vaInfo = generateVirtualAccount(it[4], it[2]);
        pendingIntents.push({
          intent_id: it[0],
          ref_code: it[2],
          amount: it[3],
          formatted_amount: formatRupiah(it[3]),
          bank: it[4],
          va_number: vaInfo.va_number,
          va_formatted: vaInfo.va_formatted,
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
