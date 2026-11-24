/**
 * Logic.gs
 * Pure domain logic (zero external dependencies) for testing and reusability.
 * Contains ref code generators, privacy masking, bank narrative parsers,
 * Virtual Account generation & decoding, and 3-tier transaction matching.
 */

// Supported banks for the scholarship donation system (SEABANK added for direct QRIS SeaBank flow)
const SUPPORTED_BANKS = ['SEABANK', 'BSI', 'MANDIRI', 'BCA', 'BNI', 'BRI'];

// Standard 5-digit Bank Virtual Account prefixes for Beasiswa IKA UPI
const BANK_VA_PREFIXES = {
  BCA: '39012',
  MANDIRI: '89508',
  BRI: '88810',
  BNI: '98814',
  BSI: '90019'
};

/**
 * Formats a sequential counter into an alphanumeric reference code (e.g., A000471 or G000012).
 * 
 * @param {string} prefix - 'A' for Alumni or 'G' for Guest.
 * @param {number} seq - Sequential counter number.
 * @returns {string} Formatted reference code with 6 digits padding.
 */
function formatRefCode(prefix, seq) {
  const p = (prefix || 'A').toUpperCase();
  const padded = String(seq || 0).padStart(6, '0');
  return p + padded;
}

/**
 * Generates a 12-digit Virtual Account number.
 * Pattern: 5-digit Bank Prefix + 1-digit Role (1=Alumni, 2=Guest) + 6-digit User Sequence.
 * E.g., BCA for Alumni A000471 -> 390121000471
 * 
 * @param {string} bank - Bank code (BCA, MANDIRI, BRI, BNI, BSI).
 * @param {string} refCode - User ref code (A000471 or G000012).
 * @returns {Object} {va_number: string, va_formatted: string}
 */
function generateVirtualAccount(bank, refCode) {
  const b = String(bank || 'BCA').toUpperCase().trim();
  const prefix = BANK_VA_PREFIXES[b] || '39012';

  const code = String(refCode || 'A000001').toUpperCase().trim();
  const roleDigit = code.startsWith('G') ? '2' : '1';
  const numPart = code.substring(1).padStart(6, '0');

  const rawVa = prefix + roleDigit + numPart;
  const formattedVa = prefix + ' ' + roleDigit + ' ' + numPart;

  return {
    va_number: rawVa,
    va_formatted: formattedVa,
    bank: b,
    bank_prefix: prefix
  };
}

/**
 * Decodes a 12-digit Virtual Account number back into its original Reference Code.
 * E.g., '390121000471' -> 'A000471', '895082000012' -> 'G000012'.
 * 
 * @param {string} vaNumber - 12-digit VA string.
 * @returns {string|null} Decoded reference code or null if invalid.
 */
function decodeRefCodeFromVA(vaNumber) {
  if (!vaNumber) return null;
  const clean = String(vaNumber).replace(/\s+/g, '');
  if (!/^\d{12}$/.test(clean)) return null;

  // The 6th digit represents role: 1 for Alumni (A), 2 for Guest (G)
  const roleChar = clean[5] === '2' ? 'G' : 'A';
  const seqDigits = clean.substring(6);
  return roleChar + seqDigits;
}

/**
 * Extracts a reference code matching pattern [AG]\d{6} or decodes a 12-digit VA number from narration text.
 * 
 * @param {string} text - Transaction description or user note.
 * @returns {string|null} The matched reference code or null if absent.
 */
function extractRefCode(text) {
  if (!text) return null;
  const cleanText = String(text).toUpperCase();

  // 1. Direct match: explicit reference code [AG]\d{6}
  const match = cleanText.match(/\b([AG]\d{6})\b/);
  if (match) return match[1];

  // 2. VA match: 12-digit number matching known bank prefix + role digit
  const vaMatch = cleanText.match(/\b(39012|89508|88810|98814|90019)([12]\d{6})\b/);
  if (vaMatch) {
    const fullVa = vaMatch[1] + vaMatch[2];
    return decodeRefCodeFromVA(fullVa);
  }

  return null;
}

/**
 * Sanitizes donor personal identity for public transparency and privacy protection (UU PDP No. 27/2022).
 * Follows OPEN-02 explicit three-state separation:
 * 1. Explicit anonymous (isAnonymous === true / 'YES') -> 'Seseorang'
 * 2. Empty/failed-to-parse bank narration -> 'Pengirim Tidak Tercatat'
 * 3. Normal named donor -> partial mask (e.g., 'Ahmad Rizki' -> 'A***d R.')
 * 
 * @param {string} rawName - Raw name candidate extracted from bank narration.
 * @param {boolean|string} [isAnonymous] - Explicit donor anonymity flag.
 * @returns {string} Sanitized display name.
 */
function maskDonorName(rawName, isAnonymous) {
  if (isAnonymous === true || String(isAnonymous || '').trim().toUpperCase() === 'YES') {
    return 'Seseorang';
  }

  if (!rawName || !String(rawName).trim()) {
    return 'Pengirim Tidak Tercatat';
  }

  const parts = String(rawName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Pengirim Tidak Tercatat';

  if (parts.length === 1) {
    const name = parts[0];
    if (name.length <= 2) return name[0] + '*';
    return name[0] + '***' + name[name.length - 1];
  }

  const first = parts[0];
  const firstMasked = (first.length <= 2)
    ? first[0] + '*'
    : first[0] + '***' + first[first.length - 1];

  const secondInitial = parts[1][0].toUpperCase() + '.';
  return firstMasked + ' ' + secondInitial;
}

/**
 * Masks bank account number preserving only first and last 2 digits.
 * 
 * @param {string} acc - Account number string.
 * @returns {string} Masked representation (e.g. 71****56).
 */
function maskAccountNumber(acc) {
  if (!acc) return '******';
  const clean = String(acc).replace(/\s+/g, '');
  if (clean.length <= 4) return '****';
  return clean.substring(0, 2) + '****' + clean.substring(clean.length - 2);
}

/**
 * Cleans extracted candidate names by stripping typical system keywords and payment tags.
 * 
 * @param {string} token - Candidate substring.
 * @returns {string} Sanitized candidate name.
 */
function cleanNameToken(token) {
  if (!token) return '';
  let cleaned = token.replace(/(?:BEASISWA|WAKAF|ZAKAT|INFAQ|SEDEKAH|DONASI|IKA\s+UPI|ALUMNI|[AG]\d{6}|\d{12}).*/i, '');
  cleaned = cleaned.trim();
  return cleaned;
}

/**
 * Parses raw bank mutasi descriptions into donor name candidate.
 * 
 * @param {string} bank - Target bank code (BSI, Mandiri, BCA, BNI, BRI).
 * @param {string} desc - Raw mutation narrative string.
 * @returns {string} Candidate donor name or empty string.
 */
function parseDonorName(bank, desc) {
  if (!desc) return '';
  const text = desc.trim();
  const b = String(bank || '').toUpperCase();

  // 1. Bank Syariah Indonesia (BSI)
  if (b === 'BSI') {
    const match = text.match(/(?:TRF|TRANSFER)\s+(?:CR\s+)?DARI\s+\d+\s+([A-Z\s\.\,\'\-]+)/i);
    if (match) return cleanNameToken(match[1]);
  }

  // 2. Bank Central Asia (BCA)
  if (b === 'BCA') {
    const match = text.match(/TRSF\s+E-BANKING\s+CR\s+[^\s]+\s+([A-Z\s\.\,\'\-]+)/i);
    if (match) return cleanNameToken(match[1]);
  }

  // 3. Bank Mandiri
  if (b === 'MANDIRI') {
    const match = text.match(/(?:TRANSFER|TRF)\s+DARI\s+\d+\s+(?:AN|A\/N)?\s*([A-Z\s\.\,\'\-]+)/i);
    if (match) return cleanNameToken(match[1]);
  }

  // 4. Bank Negara Indonesia (BNI)
  if (b === 'BNI') {
    const match = text.match(/(?:TRF|TRANSFER)\s+(?:BI-FAST\s+)?(?:CR\s+)?DARI\s+(?:BNI\s+)?(?:\d+\s+)?([A-Z\s\.\,\'\-]+)/i);
    if (match) return cleanNameToken(match[1]);
  }

  // 5. Bank Rakyat Indonesia (BRI)
  if (b === 'BRI') {
    const match = text.match(/(?:TRANSFER|TRF)\s+(?:BRIMO\s+)?DARI\s+\d+\s+([A-Z\s\.\,\'\-]+)/i);
    if (match) return cleanNameToken(match[1]);
  }

  // Generic fallback pattern
  const genericMatch = text.match(/(?:DARI|FROM|AN|A\/N)\s+([A-Z\s\.\,\'\-]+)/i);
  if (genericMatch) {
    return cleanNameToken(genericMatch[1]);
  }

  return '';
}

/**
 * Determines donation program based on description keyword matching.
 * 
 * @param {string} description - Raw narration.
 * @param {Array<{keyword: string, program: string}>} keywordList - Keyword dictionary.
 * @returns {string} Detected program, defaults to 'Umum'.
 */
function detectProgram(description, keywordList) {
  if (!description || !keywordList || keywordList.length === 0) return 'Umum';
  const upper = description.toUpperCase();
  for (let i = 0; i < keywordList.length; i++) {
    if (upper.indexOf(keywordList[i].keyword) !== -1) {
      return keywordList[i].program;
    }
  }
  return 'Umum';
}

/**
 * Checks whether a donation intent is actively PENDING, unclaimed in the current batch,
 * and not expired relative to expires_at or windowHours.
 *
 * @param {Object} intent - Intent record.
 * @param {number} windowMs - Matching window in milliseconds.
 * @param {Date} now - Reference evaluation timestamp.
 * @param {Set<string>} [claimedIntentIds] - Intent IDs already matched in current batch.
 * @returns {boolean} True when intent is eligible for matching.
 */
function isIntentEligible_(intent, windowMs, now, claimedIntentIds) {
  if (!intent) return false;
  if (String(intent.status || 'PENDING').toUpperCase() !== 'PENDING') return false;
  if (claimedIntentIds && claimedIntentIds.has(intent.intent_id)) return false;

  // Reject intents explicitly past expires_at
  if (intent.expires_at) {
    const expTime = new Date(intent.expires_at).getTime();
    if (!isNaN(expTime) && now.getTime() > expTime) {
      return false;
    }
  }

  // Reject intents outside configured matching window
  if (intent.created_at) {
    const createdMs = new Date(intent.created_at).getTime();
    if (!isNaN(createdMs) && Math.abs(now.getTime() - createdMs) > windowMs) {
      return false;
    }
  }

  return true;
}

/**
 * Core 3-tier transaction matching engine.
 * 
 * Tier 1: Exact reference code [AG]\d{6} or 12-digit Virtual Account in transfer description.
 *         Supports both registered Alumni (usersByRefCode) and non-account Guests (pendingIntents).
 * Tier 2: Exactly ONE active, unexpired donation intent matching bank, exact amount, and within time window.
 * Tier 3: Ambiguous, expired, mismatched, or no match -> Route to Admin Review Queue.
 * 
 * @param {Object} tx - Incoming mutation object {bank, amount, description, tx_date}.
 * @param {Object} context - {usersByRefCode: Map, pendingIntents: Array, windowHours: number, now: Date, claimedIntentIds?: Set}.
 * @returns {Object} Match result.
 */
function matchTransaction(tx, context) {
  const usersByRef = context.usersByRefCode || new Map();
  const pendingIntents = context.pendingIntents || [];
  const windowHours = context.windowHours || 24;
  const windowMs = windowHours * 60 * 60 * 1000;
  const now = context.now ? new Date(context.now) : new Date();
  const claimedIntentIds = context.claimedIntentIds || null;
  const txBank = String(tx.bank || '').toUpperCase().trim();
  const txAmount = parseFloat(tx.amount) || 0;

  // Tier 1: Check reference code or Virtual Account in description
  const refCodeInDesc = extractRefCode(tx.description);
  if (refCodeInDesc) {
    // Path 1A: Known registered user (Alumni or legacy Guest in users sheet)
    if (usersByRef.has(refCodeInDesc)) {
      const user = usersByRef.get(refCodeInDesc);
      let matchedIntent = null;
      for (let i = 0; i < pendingIntents.length; i++) {
        const it = pendingIntents[i];
        if (
          isIntentEligible_(it, windowMs, now, claimedIntentIds) &&
          String(it.ref_code || '').toUpperCase() === refCodeInDesc &&
          String(it.bank || '').toUpperCase() === txBank &&
          Math.abs((parseFloat(it.amount) || 0) - txAmount) < 0.01
        ) {
          matchedIntent = it;
          break;
        }
      }
      return {
        status: 'MATCHED',
        tier: 1,
        ref_code: refCodeInDesc,
        user_id: user.user_id,
        user: user,
        intent_id: matchedIntent ? matchedIntent.intent_id : null,
        intent: matchedIntent,
        reason: matchedIntent
          ? 'Matched via explicit reference code / Virtual Account with matching intent'
          : 'Matched via explicit reference code / Virtual Account (no matching pending intent closed)'
      };
    }

    // Path 1B: Non-account Guest lookup via active unexpired pendingIntents
    const refGuestMatches = [];
    const exactGuestMatches = [];
    for (let i = 0; i < pendingIntents.length; i++) {
      const it = pendingIntents[i];
      if (
        isIntentEligible_(it, windowMs, now, claimedIntentIds) &&
        String(it.ref_code || '').toUpperCase() === refCodeInDesc
      ) {
        refGuestMatches.push(it);
        if (
          String(it.bank || '').toUpperCase() === txBank &&
          Math.abs((parseFloat(it.amount) || 0) - txAmount) < 0.01
        ) {
          exactGuestMatches.push(it);
        }
      }
    }

    if (exactGuestMatches.length === 1) {
      const single = exactGuestMatches[0];
      const guestUser = single.donor_email
        ? { email: single.donor_email, full_name: single.donor_name || 'Guest Donor' }
        : null;
      return {
        status: 'MATCHED',
        tier: 1,
        ref_code: refCodeInDesc,
        user_id: single.user_id || '',
        user: guestUser,
        intent_id: single.intent_id,
        intent: single,
        reason: 'Matched Guest via explicit reference code / Virtual Account in donation_intents'
      };
    }

    if (exactGuestMatches.length > 1) {
      return {
        status: 'UNMATCHED',
        tier: 3,
        ref_code: null,
        user_id: null,
        user: null,
        intent_id: null,
        intent: null,
        candidates_count: exactGuestMatches.length,
        reason: 'Ambiguous Guest reference: ' + exactGuestMatches.length + ' active intents share ref_code (' + refCodeInDesc + ')'
      };
    }

    if (refGuestMatches.length >= 1) {
      return {
        status: 'UNMATCHED',
        tier: 3,
        ref_code: null,
        user_id: null,
        user: null,
        intent_id: null,
        intent: null,
        candidates_count: refGuestMatches.length,
        reason: 'Guest reference ' + refCodeInDesc + ' found in pending intent but bank or amount does not match'
      };
    }

    // Explicit reference code was present but unknown/expired/already paid: route to review queue (never cross-match via Tier 2)
    return {
      status: 'UNMATCHED',
      tier: 3,
      ref_code: null,
      user_id: null,
      user: null,
      intent_id: null,
      intent: null,
      candidates_count: 0,
      reason: 'Reference code ' + refCodeInDesc + ' is unknown, expired, or already settled'
    };
  }

  // Tier 2: Check matching active pending intents by Bank + Exact Amount + Within Time Window
  const candidates = [];
  for (let i = 0; i < pendingIntents.length; i++) {
    const intent = pendingIntents[i];
    if (
      isIntentEligible_(intent, windowMs, now, claimedIntentIds) &&
      String(intent.bank || '').toUpperCase() === txBank &&
      Math.abs((parseFloat(intent.amount) || 0) - txAmount) < 0.01
    ) {
      candidates.push(intent);
    }
  }

  if (candidates.length === 1) {
    const singleIntent = candidates[0];
    const user =
      usersByRef.get(singleIntent.ref_code) ||
      (singleIntent.donor_email
        ? { email: singleIntent.donor_email, full_name: singleIntent.donor_name || 'Guest Donor' }
        : null);
    return {
      status: 'MATCHED',
      tier: 2,
      ref_code: singleIntent.ref_code,
      user_id: user && user.user_id ? user.user_id : (singleIntent.user_id || ''),
      user: user,
      intent_id: singleIntent.intent_id,
      intent: singleIntent,
      reason: 'Matched uniquely via Bank + Amount within ' + windowHours + 'h window'
    };
  }

  // Tier 3: Multiple candidates (collision) or no candidate found
  const reason = candidates.length > 1
    ? 'Ambiguous match: ' + candidates.length + ' intents share bank (' + txBank + ') and amount (' + txAmount + ')'
    : 'No reference code / VA in note and no matching intent found';

  return {
    status: 'UNMATCHED',
    tier: 3,
    ref_code: null,
    user_id: null,
    user: null,
    intent_id: null,
    intent: null,
    candidates_count: candidates.length,
    reason: reason
  };
}

/**
 * Currency formatter for IDR.
 * 
 * @param {number} num - Raw amount.
 * @returns {string} E.g., Rp 500.000.
 */
function formatRupiah(num) {
  const parts = Math.round(num || 0).toString().split('');
  let formatted = '';
  let count = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    formatted = parts[i] + formatted;
    count++;
    if (count % 3 === 0 && i !== 0) {
      formatted = '.' + formatted;
    }
  }
  return 'Rp ' + formatted;
}

/**
 * Canonical 5-level alumni verification status constants.
 */
var VERIFICATION_STATUSES = {
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  PENDING: 'PENDING',
  NEEDS_REVISION: 'NEEDS_REVISION',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
};

/**
 * Allowed MIME types and extensions for alumni proof uploads (<= 5MB).
 */
var ALLOWED_PROOF_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
var MAX_PROOF_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Normalizes legacy (NONE, VERIFIED) and target 5-level verification status values
 * so the application stays compatible both before and after P2.2 migration.
 *
 * @param {string} status - Raw verification status from Google Sheets or payload.
 * @returns {string} Canonical status: NOT_SUBMITTED | PENDING | NEEDS_REVISION | APPROVED | REJECTED.
 */
function normalizeVerificationStatus(status) {
  const raw = String(status || '').trim().toUpperCase();
  if (!raw || raw === 'NONE' || raw === VERIFICATION_STATUSES.NOT_SUBMITTED) {
    return VERIFICATION_STATUSES.NOT_SUBMITTED;
  }
  if (raw === 'VERIFIED' || raw === VERIFICATION_STATUSES.APPROVED) {
    return VERIFICATION_STATUSES.APPROVED;
  }
  if (
    raw === VERIFICATION_STATUSES.PENDING ||
    raw === VERIFICATION_STATUSES.NEEDS_REVISION ||
    raw === VERIFICATION_STATUSES.REJECTED
  ) {
    return raw;
  }
  return VERIFICATION_STATUSES.NOT_SUBMITTED;
}

/**
 * Checks whether a user status grants permission to create alumni donations.
 *
 * @param {string} status - User verification status (legacy or canonical).
 * @returns {boolean} True when status equals APPROVED or legacy VERIFIED.
 */
function isApprovedVerificationStatus(status) {
  return normalizeVerificationStatus(status) === VERIFICATION_STATUSES.APPROVED;
}

/**
 * Checks whether an alumnus is allowed to submit or resubmit verification proof.
 * Enforces OPEN-01: REJECTED is final, APPROVED cannot downgrade, PENDING awaits review.
 *
 * @param {string} currentStatus - Current status stored in database.
 * @returns {Object} { allowed: boolean, normalizedStatus: string, message: string }.
 */
function canAlumniSubmitVerification(currentStatus) {
  const normalized = normalizeVerificationStatus(currentStatus);
  if (
    normalized === VERIFICATION_STATUSES.NOT_SUBMITTED ||
    normalized === VERIFICATION_STATUSES.NEEDS_REVISION
  ) {
    return { allowed: true, normalizedStatus: normalized, message: '' };
  }
  if (normalized === VERIFICATION_STATUSES.APPROVED) {
    return {
      allowed: false,
      normalizedStatus: normalized,
      message: 'Forbidden: Akun Anda sudah berstatus Alumni Terverifikasi dan tidak dapat kembali ke PENDING.'
    };
  }
  if (normalized === VERIFICATION_STATUSES.PENDING) {
    return {
      allowed: false,
      normalizedStatus: normalized,
      message: 'Pengajuan verifikasi Anda sebelumnya masih berstatus PENDING dan sedang ditinjau admin.'
    };
  }
  // OPEN-01 final rejection guard
  return {
    allowed: false,
    normalizedStatus: normalized,
    message: 'Forbidden: Pengajuan verifikasi telah DITOLAK secara final (REJECTED) dan tidak dapat diajukan ulang.'
  };
}

/**
 * Validates admin review state transitions against the alumni verification state machine.
 * Only PENDING tickets can transition to APPROVED, NEEDS_REVISION, or REJECTED.
 *
 * @param {string} currentVerifStatus - Current ticket status in alumni_verifications.
 * @param {string|boolean} decisionOrApprove - Canonical decision string or legacy boolean.
 * @param {string} reason - Reviewer note (mandatory for NEEDS_REVISION and REJECTED).
 * @returns {Object} { ok: boolean, decision: string, reason: string, error?: string }.
 */
function validateVerificationTransition(currentVerifStatus, decisionOrApprove, reason) {
  const currentNorm = normalizeVerificationStatus(currentVerifStatus);
  if (currentNorm !== VERIFICATION_STATUSES.PENDING) {
    return {
      ok: false,
      error: 'Tiket ini sudah diproses sebelumnya dengan status: ' + currentNorm
    };
  }

  let decision = '';
  if (typeof decisionOrApprove === 'boolean') {
    decision = decisionOrApprove ? VERIFICATION_STATUSES.APPROVED : VERIFICATION_STATUSES.REJECTED;
  } else {
    const rawDec = String(decisionOrApprove || '').trim().toUpperCase();
    if (rawDec === 'VERIFIED' || rawDec === 'APPROVE') {
      decision = VERIFICATION_STATUSES.APPROVED;
    } else if (rawDec === 'REJECT') {
      decision = VERIFICATION_STATUSES.REJECTED;
    } else {
      decision = rawDec;
    }
  }

  if (
    decision !== VERIFICATION_STATUSES.APPROVED &&
    decision !== VERIFICATION_STATUSES.NEEDS_REVISION &&
    decision !== VERIFICATION_STATUSES.REJECTED
  ) {
    return {
      ok: false,
      error: 'Keputusan review tidak valid. Gunakan APPROVED, NEEDS_REVISION, atau REJECTED.'
    };
  }

  const trimmedReason = String(reason || '').trim();
  if (
    (decision === VERIFICATION_STATUSES.NEEDS_REVISION || decision === VERIFICATION_STATUSES.REJECTED) &&
    !trimmedReason
  ) {
    return {
      ok: false,
      error: 'Alasan wajib diisi untuk keputusan ' + decision + '.'
    };
  }

  return {
    ok: true,
    decision: decision,
    reason: sanitizeSpreadsheetFormula(trimmedReason)
  };
}

/**
 * Neutralizes leading formula-injection characters before persisting text into Google Sheets.
 *
 * @param {string} value - Arbitrary client text input.
 * @returns {string} Sanitized plain text safe for spreadsheet cells.
 */
function sanitizeSpreadsheetFormula(value) {
  const str = String(value === undefined || value === null ? '' : value).trim();
  if (!str) return '';
  if (/^[=+\-@\t\r]/.test(str)) {
    return "'" + str;
  }
  return str;
}

/**
 * Validates proof document MIME type, filename safety, and byte size (<= 5MB).
 *
 * @param {string} fileMime - Uploaded MIME type.
 * @param {string} fileName - Uploaded filename.
 * @param {number} byteLength - Decoded byte count.
 * @returns {Object} { ok: boolean, normalizedMime: string, error?: string }.
 */
function validateProofFileMetadata(fileMime, fileName, byteLength) {
  const mime = String(fileMime || '').trim().toLowerCase();
  const normalizedMime = mime === 'image/jpg' ? 'image/jpeg' : mime;

  if (!normalizedMime || ALLOWED_PROOF_MIME_TYPES.indexOf(normalizedMime) === -1) {
    return {
      ok: false,
      normalizedMime: normalizedMime,
      error: 'Format berkas tidak didukung. Unggah PDF, JPG, atau PNG.'
    };
  }

  const cleanName = String(fileName || '').trim().toLowerCase();
  if (cleanName && !/\.(pdf|png|jpe?g)$/.test(cleanName)) {
    return {
      ok: false,
      normalizedMime: normalizedMime,
      error: 'Ekstensi berkas bukti harus .pdf, .png, .jpg, atau .jpeg.'
    };
  }

  if (!byteLength || isNaN(byteLength) || byteLength <= 0) {
    return {
      ok: false,
      normalizedMime: normalizedMime,
      error: 'Berkas bukti kosong atau tidak valid.'
    };
  }

  if (byteLength > MAX_PROOF_FILE_BYTES) {
    return {
      ok: false,
      normalizedMime: normalizedMime,
      error: 'Ukuran file bukti melebihi batas 5MB.'
    };
  }

  return { ok: true, normalizedMime: normalizedMime };
}

/**
 * Supported payment channels for donation intent creation.
 */
var SUPPORTED_PAYMENT_CHANNELS = ['QRIS_SEABANK', 'MANUAL_TRANSFER', 'MIDTRANS_SNAP'];
// Minimum donation lowered to Rp 100 per real-payment QRIS SeaBank requirement
var DEFAULT_MIN_DONATION_AMOUNT = 100;
var DEFAULT_MAX_DONATION_AMOUNT = 100000000;

/**
 * Formats sequential program master IDs (PRG-001, PRG-006, etc.).
 *
 * @param {number} seq - Numeric sequence counter value.
 * @returns {string} Zero-padded program ID.
 */
function formatProgramId(seq) {
  const num = parseInt(seq, 10) || 0;
  return 'PRG-' + String(num).padStart(3, '0');
}

/**
 * Generates a deterministic Midtrans-safe order ID (<= 50 alphanumeric/hyphen chars).
 *
 * @param {string} refCode - Donor ref code (A000471 or G000012).
 * @param {string} intentId - Intent identifier (INT_xxxxxxxx).
 * @returns {string} Order identifier for Snap transactions.
 */
function formatMidtransOrderId(refCode, intentId) {
  const cleanRef = String(refCode || 'DONOR').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const cleanIntent = String(intentId || '').replace(/^INT_?/i, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return ('DON-' + cleanRef + '-' + cleanIntent).slice(0, 50);
}

/**
 * Extracts a donor reference code (A000xxx or G000xxx) embedded inside a Midtrans order_id.
 *
 * @param {string} orderId - Midtrans order_id string.
 * @returns {string|null} Extracted uppercase reference code or null.
 */
function extractRefCodeFromOrderId(orderId) {
  if (!orderId || typeof orderId !== 'string') return null;
  const match = orderId.toUpperCase().match(/\b([AG]\d{6})\b/);
  return match ? match[1] : null;
}

/**
 * Builds the exact concatenation input required by Midtrans SHA-512 signature verification:
 * order_id + status_code + gross_amount + ServerKey (preserving gross_amount string decimals).
 *
 * @param {string} orderId - Midtrans order_id.
 * @param {string|number} statusCode - Midtrans status_code (e.g. "200").
 * @param {string|number} grossAmountStr - Exact gross_amount from notification (e.g. "150000.00").
 * @param {string} serverKey - Midtrans Server Key from ScriptProperties.
 * @returns {string} Raw signature input string.
 */
function buildMidtransSignatureInput(orderId, statusCode, grossAmountStr, serverKey) {
  return (
    String(orderId === undefined || orderId === null ? '' : orderId) +
    String(statusCode === undefined || statusCode === null ? '' : statusCode) +
    String(grossAmountStr === undefined || grossAmountStr === null ? '' : grossAmountStr) +
    String(serverKey === undefined || serverKey === null ? '' : serverKey)
  );
}

/**
 * Verifies a Midtrans notification signature_key using constant-time comparison.
 *
 * @param {Object} payload - Notification body containing order_id, status_code, gross_amount, signature_key.
 * @param {string} serverKey - Authoritative Midtrans Server Key.
 * @param {Function} sha512HexFn - Function(string) -> 128-char hex SHA-512 digest.
 * @returns {boolean} True only if all fields exist and the SHA-512 signature matches.
 */
function verifyMidtransSignature(payload, serverKey, sha512HexFn) {
  if (!payload || typeof payload !== 'object') return false;
  const orderId = String(payload.order_id || '').trim();
  const statusCode = String(payload.status_code || '').trim();
  const grossAmount = payload.gross_amount !== undefined && payload.gross_amount !== null ? String(payload.gross_amount).trim() : '';
  const providedSig = String(payload.signature_key || '').trim().toLowerCase();
  const key = String(serverKey || '').trim();

  if (!orderId || !statusCode || !grossAmount || !providedSig || !key || typeof sha512HexFn !== 'function') {
    return false;
  }
  if (!/^[0-9a-f]{128}$/.test(providedSig)) {
    return false;
  }

  const rawInput = buildMidtransSignatureInput(orderId, statusCode, grossAmount, key);
  const expectedSig = String(sha512HexFn(rawInput) || '').trim().toLowerCase();
  if (expectedSig.length !== 128 || providedSig.length !== expectedSig.length) {
    return false;
  }

  // Perform constant-time bitwise comparison across all 128 hex characters
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) {
    diff |= expectedSig.charCodeAt(i) ^ providedSig.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Maps a Midtrans notification/inquiry payload into a normalized bank/channel label for reporting.
 *
 * @param {Object} payload - Midtrans status or webhook payload.
 * @returns {string} Normalized channel identifier (e.g. MIDTRANS_BCA, MIDTRANS_MANDIRI, MIDTRANS_QRIS).
 */
function normalizeMidtransChannel(payload) {
  if (!payload || typeof payload !== 'object') return 'MIDTRANS_SNAP';
  const paymentType = String(payload.payment_type || '').trim().toLowerCase();

  if (paymentType === 'bank_transfer') {
    if (Array.isArray(payload.va_numbers) && payload.va_numbers.length > 0 && payload.va_numbers[0].bank) {
      return 'MIDTRANS_' + String(payload.va_numbers[0].bank).trim().toUpperCase();
    }
    if (payload.permata_va_number) {
      return 'MIDTRANS_PERMATA';
    }
    if (payload.bank) {
      return 'MIDTRANS_' + String(payload.bank).trim().toUpperCase();
    }
    return 'MIDTRANS_VA';
  }
  if (paymentType === 'echannel') {
    return 'MIDTRANS_MANDIRI';
  }
  if (paymentType === 'qris') {
    return 'MIDTRANS_QRIS';
  }
  if (paymentType === 'gopay') {
    return 'MIDTRANS_GOPAY';
  }
  if (paymentType === 'shopeepay') {
    return 'MIDTRANS_SHOPEEPAY';
  }
  if (paymentType === 'cstore') {
    return 'MIDTRANS_' + String(payload.store || 'CSTORE').trim().toUpperCase();
  }
  if (paymentType) {
    return 'MIDTRANS_' + paymentType.toUpperCase();
  }
  return 'MIDTRANS_SNAP';
}

/**
 * Maps Midtrans transaction_status and fraud_status into DonasiAlumniApp's separated
 * State Machine 1 (donation_intents.status) and State Machine 3 (transactions.gateway_status).
 *
 * @param {string} transactionStatus - Raw Midtrans transaction_status.
 * @param {string=} fraudStatus - Raw Midtrans fraud_status ('accept', 'challenge', 'deny').
 * @returns {Object} { intent_status, gateway_status, should_finalize_tx, is_reversal, is_terminal_failure }.
 */
function mapMidtransTransactionState(transactionStatus, fraudStatus) {
  const txStat = String(transactionStatus || '').trim().toLowerCase();
  const fraud = String(fraudStatus || '').trim().toLowerCase();

  // HTTP 404 before customer selects a payment method in Snap popup remains PENDING (State Machine 3)
  if (!txStat || txStat === 'not_found_404' || txStat === '404') {
    return {
      intent_status: 'PENDING',
      gateway_status: 'NOT_FOUND_404',
      should_finalize_tx: false,
      is_reversal: false,
      is_terminal_failure: false
    };
  }

  if (txStat === 'pending') {
    return {
      intent_status: 'PENDING',
      gateway_status: 'PENDING',
      should_finalize_tx: false,
      is_reversal: false,
      is_terminal_failure: false
    };
  }

  if (txStat === 'settlement') {
    return {
      intent_status: 'MATCHED',
      gateway_status: 'SETTLED',
      should_finalize_tx: true,
      is_reversal: false,
      is_terminal_failure: false
    };
  }

  if (txStat === 'capture') {
    if (fraud === 'challenge') {
      // Hold confirmation and do NOT issue receipt_no while under fraud challenge
      return {
        intent_status: 'PENDING',
        gateway_status: 'CHALLENGE',
        should_finalize_tx: false,
        is_reversal: false,
        is_terminal_failure: false
      };
    }
    if (fraud === 'deny') {
      return {
        intent_status: 'FAILED',
        gateway_status: 'DENIED',
        should_finalize_tx: false,
        is_reversal: false,
        is_terminal_failure: true
      };
    }
    return {
      intent_status: 'MATCHED',
      gateway_status: 'CAPTURE_ACCEPTED',
      should_finalize_tx: true,
      is_reversal: false,
      is_terminal_failure: false
    };
  }

  if (txStat === 'expire') {
    return {
      intent_status: 'EXPIRED',
      gateway_status: 'EXPIRED',
      should_finalize_tx: false,
      is_reversal: false,
      is_terminal_failure: true
    };
  }

  if (txStat === 'cancel') {
    return {
      intent_status: 'CANCELLED',
      gateway_status: 'CANCELLED',
      should_finalize_tx: false,
      is_reversal: false,
      is_terminal_failure: true
    };
  }

  if (txStat === 'deny' || txStat === 'failure') {
    return {
      intent_status: 'FAILED',
      gateway_status: 'DENIED',
      should_finalize_tx: false,
      is_reversal: false,
      is_terminal_failure: true
    };
  }

  if (txStat === 'refund') {
    return {
      intent_status: 'MATCHED',
      gateway_status: 'REFUNDED',
      should_finalize_tx: false,
      is_reversal: true,
      is_terminal_failure: false
    };
  }

  if (txStat === 'partial_refund') {
    return {
      intent_status: 'MATCHED',
      gateway_status: 'PARTIAL_REFUNDED',
      should_finalize_tx: false,
      is_reversal: true,
      is_terminal_failure: false
    };
  }

  if (txStat === 'chargeback') {
    return {
      intent_status: 'MATCHED',
      gateway_status: 'CHARGEBACK',
      should_finalize_tx: false,
      is_reversal: true,
      is_terminal_failure: false
    };
  }

  return {
    intent_status: 'PENDING',
    gateway_status: txStat.toUpperCase(),
    should_finalize_tx: false,
    is_reversal: false,
    is_terminal_failure: false
  };
}

/**
 * Validates donation amount against system minimum (Rp 10.000) and configured ceiling.
 *
 * @param {number|string} rawAmount - Submitted nominal amount.
 * @param {number=} maxAmount - Optional maximum ceiling override.
 * @returns {Object} { ok: boolean, amount: number, error?: string }.
 */
function validateDonationAmount(rawAmount, maxAmount) {
  const ceil = parseFloat(maxAmount) || DEFAULT_MAX_DONATION_AMOUNT;
  const amount = Number(rawAmount);
  if (isNaN(amount) || !isFinite(amount) || Math.floor(amount) !== amount) {
    return { ok: false, amount: 0, error: 'Nominal donasi harus berupa bilangan bulat rupiah yang valid.' };
  }
  if (amount < DEFAULT_MIN_DONATION_AMOUNT) {
    return { ok: false, amount: 0, error: 'Nominal donasi minimal Rp ' + DEFAULT_MIN_DONATION_AMOUNT.toLocaleString('id-ID') + '.' };
  }
  if (amount > ceil) {
    return { ok: false, amount: 0, error: 'Nominal donasi melebihi batas maksimal transaksi (' + formatRupiah(ceil) + ').' };
  }
  return { ok: true, amount: amount };
}

/**
 * Checks whether an email address matches a clean RFC-practical format.
 *
 * @param {string} email - Candidate email address.
 * @returns {boolean} True if structurally valid.
 */
function isValidEmailFormat(email) {
  const str = String(email || '').trim();
  if (!str || str.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str);
}

/**
 * Validates and sanitizes accountless Guest checkout input payload before persistence.
 *
 * @param {Object} data - Submitted guest checkout payload.
 * @param {number=} maxAmount - Configured maximum donation ceiling.
 * @returns {Object} { ok: boolean, value?: Object, error?: string }.
 */
function validateGuestDonorInput(data, maxAmount) {
  const input = data || {};
  if (input.consent !== true && String(input.consent).toLowerCase() !== 'true') {
    return { ok: false, error: 'Persetujuan pemrosesan data pribadi (UU No. 27/2022) wajib disetujui.' };
  }

  const rawName = sanitizeSpreadsheetFormula(input.donor_name);
  if (!rawName || rawName.length < 2 || rawName.length > 120) {
    return { ok: false, error: 'Nama lengkap donatur wajib diisi (minimal 2 karakter).' };
  }

  const emailTrimmed = String(input.donor_email || '').trim().toLowerCase();
  if (!isValidEmailFormat(emailTrimmed)) {
    return { ok: false, error: 'Format alamat email donatur tidak valid.' };
  }
  const safeEmail = sanitizeSpreadsheetFormula(emailTrimmed);

  const amtCheck = validateDonationAmount(input.amount, maxAmount);
  if (!amtCheck.ok) {
    return { ok: false, error: amtCheck.error };
  }

  const channel = String(input.payment_channel || 'MANUAL_TRANSFER').trim().toUpperCase();
  if (SUPPORTED_PAYMENT_CHANNELS.indexOf(channel) === -1) {
    return {
      ok: false,
      error: 'Kanal pembayaran tidak valid. Pilihan: ' + SUPPORTED_PAYMENT_CHANNELS.join(', ')
    };
  }

  let bank = String(input.bank || '').trim().toUpperCase();
  if (channel === 'QRIS_SEABANK') {
    bank = 'SEABANK';
  } else if (channel === 'MANUAL_TRANSFER') {
    if (SUPPORTED_BANKS.indexOf(bank) === -1) {
      return { ok: false, error: 'Bank tujuan tidak didukung. Pilihan: ' + SUPPORTED_BANKS.join(', ') };
    }
  } else {
    bank = bank || 'MIDTRANS';
  }

  return {
    ok: true,
    value: {
      donor_name: rawName,
      donor_email: safeEmail,
      amount: amtCheck.amount,
      payment_channel: channel,
      bank: bank,
      is_anonymous: input.is_anonymous === true || String(input.is_anonymous).toUpperCase() === 'YES' ? 'YES' : 'NO'
    }
  };
}

/**
 * Computes ISO/IEC 13239 CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) required by EMVCo QRIS Tag 63.
 */
function computeCrc16Ccitt(str) {
  let crc = 0xffff;
  const input = String(str || '');
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Converts a static EMVCo QRIS string (000201010211...) into a dynamic QRIS with locked Tag 54 amount
 * and recomputed Tag 63 CRC-16/CCITT-FALSE so any Indonesian bank/e-wallet pre-fills the exact nominal.
 */
function generateDynamicQrisPayload(staticQris, amount) {
  const raw = String(staticQris || '').trim();
  const numAmount = Math.round(Number(amount) || 0);
  if (!raw || numAmount <= 0) {
    throw new Error('Static QRIS payload dan nominal positif wajib tersedia.');
  }

  // Strip existing trailing CRC tag 6304XXXX if present
  let body = raw.replace(/6304[0-9A-Fa-f]{4}$/, '');

  // Switch Point of Initiation Method from static (010211) to dynamic (010212)
  body = body.replace('010211', '010212');

  const countryIdx = body.indexOf('5802ID');
  if (countryIdx === -1) {
    throw new Error('Format QRIS statis tidak valid: penanda negara 5802ID tidak ditemukan.');
  }

  let beforeCountry = body.slice(0, countryIdx);
  const fromCountry = body.slice(countryIdx);

  // Remove any pre-existing Tag 54 (Transaction Amount) before re-injecting the requested amount
  beforeCountry = beforeCountry.replace(/54(\d{2})([0-9.]+)/g, function (full, lenStr, val) {
    const len = parseInt(lenStr, 10);
    return val.length >= len ? val.slice(len) : full;
  });

  const amtStr = String(numAmount);
  const tag54 = '54' + String(amtStr.length).padStart(2, '0') + amtStr;
  const payloadWithCrcTag = beforeCountry + tag54 + fromCountry + '6304';
  return payloadWithCrcTag + computeCrc16Ccitt(payloadWithCrcTag);
}

/**
 * Allocates a unique payable nominal (baseAmount + uniqueCode) that does not collide
 * with any currently active PENDING intent amount for SeaBank QRIS auto-matching.
 */
function allocateUniqueDonationAmount(baseAmount, activePendingAmounts) {
  const base = Math.round(Number(baseAmount) || 0);
  const used = new Set();
  (activePendingAmounts || []).forEach(function (val) {
    const n = Math.round(Number(val) || 0);
    if (n > 0) used.add(n);
  });

  // Prefer 2-digit unique codes (1..99) first, then expand to 100..999 if busy
  for (let code = 1; code <= 99; code++) {
    if (!used.has(base + code)) {
      return { base_amount: base, unique_code: code, payable_amount: base + code };
    }
  }
  for (let code = 100; code <= 999; code++) {
    if (!used.has(base + code)) {
      return { base_amount: base, unique_code: code, payable_amount: base + code };
    }
  }
  // shortcut: falls back to base amount when >999 concurrent pending intents share the exact same base nominal
  return { base_amount: base, unique_code: 0, payable_amount: base };
}

/**
 * Parses a SeaBank incoming funds / QRIS email notification into a structured credit mutation.
 * Returns null if the email does not represent an incoming credit (e.g. debit/outgoing transfer).
 */
function parseSeabankNotificationEmail(subject, body) {
  const subj = String(subject || '').trim();
  const text = String(body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const combined = subj + ' ' + text;

  // Reject outgoing / debit notifications (including SeaBank Top Up e-Wallet) so only incoming credits are recorded
  if (/(top\s*up\s*e-?wallet|berhasil dikirim|transfer keluar|pembayaran ke|debit|tarik tunai|keluar dari rekening)/i.test(combined)) {
    return null;
  }

  // Prefer explicit 'Jumlah' row amount when present in SeaBank HTML/text alert tables, else fallback to first IDR/Rp amount
  const jumlahMatch = text.match(/Jumlah\s*:?\s*(?:Rp\.?|IDR)\s*([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]+)(?:[.,]00)?\b/i);
  const amtMatch = jumlahMatch || combined.match(/(?:Rp\.?|IDR)\s*([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]+)(?:[.,]00)?\b/i);
  if (!amtMatch) {
    return null;
  }
  const normalizedNum = amtMatch[1].replace(/[.,]/g, '');
  const amount = parseInt(normalizedNum, 10) || 0;
  if (amount <= 0) {
    return null;
  }

  // Extract optional sender name from SeaBank table ("Transfer Dari ...") or narrative ("dari ...")
  let senderName = '';
  const tableSender = text.match(/Transfer\s+Dari\s*:?\s*([A-Za-z][A-Za-z0-9 .,'-]{1,60}?)(?:\s*-\s*\d+|\s+Rekening|\s+Jumlah|$)/i);
  const narrativeSender = text.match(/(?:dari|from)\s+([A-Za-z][A-Za-z0-9 .,'-]{1,60}?)(?:\s+(?:sebesar|pada|ke|via|melalui|di|sejumlah|\.|,|$))/i);
  if (tableSender && tableSender[1]) {
    senderName = cleanNameToken(tableSender[1]);
  } else if (narrativeSender && narrativeSender[1]) {
    senderName = cleanNameToken(narrativeSender[1]);
  }

  return {
    bank: 'SEABANK',
    type: 'CR',
    amount: amount,
    sender_name: senderName,
    description: ('SEABANK QRIS ' + (senderName ? 'DARI ' + senderName + ' ' : '') + subj).trim().slice(0, 200)
  };
}

// Export for Node.js test environment if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUPPORTED_BANKS,
    BANK_VA_PREFIXES,
    SUPPORTED_PAYMENT_CHANNELS,
    VERIFICATION_STATUSES,
    ALLOWED_PROOF_MIME_TYPES,
    MAX_PROOF_FILE_BYTES,
    formatRefCode,
    generateVirtualAccount,
    decodeRefCodeFromVA,
    extractRefCode,
    maskDonorName,
    maskAccountNumber,
    cleanNameToken,
    parseDonorName,
    detectProgram,
    matchTransaction,
    formatRupiah,
    normalizeVerificationStatus,
    isApprovedVerificationStatus,
    canAlumniSubmitVerification,
    validateVerificationTransition,
    sanitizeSpreadsheetFormula,
    validateProofFileMetadata,
    formatProgramId,
    formatMidtransOrderId,
    extractRefCodeFromOrderId,
    buildMidtransSignatureInput,
    verifyMidtransSignature,
    normalizeMidtransChannel,
    mapMidtransTransactionState,
    validateDonationAmount,
    isValidEmailFormat,
    validateGuestDonorInput,
    computeCrc16Ccitt,
    generateDynamicQrisPayload,
    allocateUniqueDonationAmount,
    parseSeabankNotificationEmail
  };
}
