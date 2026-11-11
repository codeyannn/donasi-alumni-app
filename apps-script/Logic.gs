/**
 * Logic.gs
 * Pure domain logic (zero external dependencies) for testing and reusability.
 * Contains ref code generators, privacy masking, bank narrative parsers,
 * Virtual Account generation & decoding, and 3-tier transaction matching.
 */

// Supported banks for the scholarship donation system
const SUPPORTED_BANKS = ['BSI', 'MANDIRI', 'BCA', 'BNI', 'BRI'];

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
 * E.g., 'Ahmad Rizki' -> 'A***d R.', empty -> 'Hamba Allah'.
 * 
 * @param {string} rawName - Raw name candidate extracted from bank narration.
 * @returns {string} Masked name.
 */
function maskDonorName(rawName) {
  if (!rawName || !rawName.trim()) {
    return 'Hamba Allah';
  }

  const parts = rawName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Hamba Allah';

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
 * Core 3-tier transaction matching engine.
 * 
 * Tier 1: Exact reference code [AG]\d{6} or 12-digit Virtual Account in transfer description.
 * Tier 2: Exactly ONE active donation intent matching bank, exact amount, and within time window.
 * Tier 3: Ambiguous or no match -> Route to Admin Review Queue.
 * 
 * @param {Object} tx - Incoming mutation object {bank, amount, description, tx_date}.
 * @param {Object} context - {usersByRefCode: Map, pendingIntents: Array, windowHours: number, now: Date}.
 * @returns {Object} Match result.
 */
function matchTransaction(tx, context) {
  const usersByRef = context.usersByRefCode || new Map();
  const pendingIntents = context.pendingIntents || [];
  const windowHours = context.windowHours || 24;
  const now = context.now ? new Date(context.now) : new Date();

  // Tier 1: Check reference code or Virtual Account in description
  const refCodeInDesc = extractRefCode(tx.description);
  if (refCodeInDesc && usersByRef.has(refCodeInDesc)) {
    const user = usersByRef.get(refCodeInDesc);
    let matchedIntent = null;
    for (let i = 0; i < pendingIntents.length; i++) {
      const it = pendingIntents[i];
      if (it.ref_code === refCodeInDesc && it.bank === tx.bank && Math.abs(it.amount - tx.amount) < 0.01) {
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
      reason: 'Matched via explicit reference code / Virtual Account in description'
    };
  }

  // Tier 2: Check matching pending intents by Bank + Exact Amount + Within Time Window
  const candidates = [];
  const windowMs = windowHours * 60 * 60 * 1000;

  for (let i = 0; i < pendingIntents.length; i++) {
    const intent = pendingIntents[i];
    if (intent.bank === tx.bank && Math.abs(intent.amount - tx.amount) < 0.01) {
      const intentCreatedAt = new Date(intent.created_at).getTime();
      const diff = Math.abs(now.getTime() - intentCreatedAt);
      if (diff <= windowMs) {
        candidates.push(intent);
      }
    }
  }

  if (candidates.length === 1) {
    const singleIntent = candidates[0];
    const user = usersByRef.get(singleIntent.ref_code) || null;
    return {
      status: 'MATCHED',
      tier: 2,
      ref_code: singleIntent.ref_code,
      user_id: user ? user.user_id : singleIntent.user_id,
      user: user,
      intent_id: singleIntent.intent_id,
      intent: singleIntent,
      reason: 'Matched uniquely via Bank + Amount within ' + windowHours + 'h window'
    };
  }

  // Tier 3: Multiple candidates (collision) or no candidate found
  const reason = candidates.length > 1
    ? 'Ambiguous match: ' + candidates.length + ' intents share bank (' + tx.bank + ') and amount (' + tx.amount + ')'
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

// Export for Node.js test environment if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUPPORTED_BANKS,
    BANK_VA_PREFIXES,
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
    formatRupiah
  };
}
