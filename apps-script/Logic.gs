/**
 * Logic.gs
 * Pure domain logic (zero external dependencies) for testing and reusability.
 * Contains ref code generators, privacy masking, bank narrative parsers, and 3-tier transaction matching.
 */

// Supported banks for the scholarship donation system
const SUPPORTED_BANKS = ["BSI", "MANDIRI", "BCA", "BNI", "BRI"];

/**
 * Formats a sequential counter into an alphanumeric reference code (e.g., A000471 or G000012).
 *
 * @param {string} prefix - 'A' for Alumni or 'G' for Guest.
 * @param {number} seq - Sequential counter number.
 * @returns {string} Formatted reference code with 6 digits padding.
 */
function formatRefCode(prefix, seq) {
  // Ensure prefix is uppercase and safe
  const p = (prefix || "A").toUpperCase();
  // Pad sequence with leading zeros to 6 digits
  const padded = String(seq || 0).padStart(6, "0");
  return p + padded;
}

/**
 * Extracts a reference code matching pattern [AG]\d{6} from text (such as transaction notes).
 *
 * @param {string} text - Transaction description or user note.
 * @returns {string|null} The matched reference code or null if absent.
 */
function extractRefCode(text) {
  if (!text) return null;
  // Match word boundary followed by A or G and exactly 6 digits
  const match = String(text)
    .toUpperCase()
    .match(/\b([AG]\d{6})\b/);
  return match ? match[1] : null;
}

/**
 * Sanitizes donor personal identity for public transparency and privacy protection (UU PDP No. 27/2022).
 * E.g., 'Ahmad Rizki' -> 'A***d R.', empty -> 'Seseorang'.
 *
 * @param {string} rawName - Raw name candidate extracted from bank narration.
 * @returns {string} Masked name.
 */
function maskDonorName(rawName) {
  if (!rawName || !rawName.trim()) {
    return "Seseorang";
  }

  // Split into tokens removing extra whitespaces
  const parts = rawName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Seseorang";

  if (parts.length === 1) {
    const name = parts[0];
    if (name.length <= 2) return name[0] + "*";
    // Preserve first and last character with 3 asterisks in between
    return name[0] + "***" + name[name.length - 1];
  }

  // Multi-word name: mask the first word, take initial of second word
  const first = parts[0];
  const firstMasked =
    first.length <= 2
      ? first[0] + "*"
      : first[0] + "***" + first[first.length - 1];

  const secondInitial = parts[1][0].toUpperCase() + ".";
  return firstMasked + " " + secondInitial;
}

/**
 * Masks bank account number preserving only first and last 2 digits.
 *
 * @param {string} acc - Account number string.
 * @returns {string} Masked representation (e.g. 71****56).
 */
function maskAccountNumber(acc) {
  if (!acc) return "******";
  const clean = String(acc).replace(/\s+/g, "");
  if (clean.length <= 4) return "****";
  return clean.substring(0, 2) + "****" + clean.substring(clean.length - 2);
}

/**
 * Cleans extracted candidate names by stripping typical system keywords and payment tags.
 *
 * @param {string} token - Candidate substring.
 * @returns {string} Sanitized candidate name.
 */
function cleanNameToken(token) {
  if (!token) return "";
  // Cut off words starting with known noise keywords
  let cleaned = token.replace(
    /(?:BEASISWA|WAKAF|ZAKAT|INFAQ|SEDEKAH|DONASI|IKA\s+UPI|ALUMNI|[AG]\d{6}).*/i,
    "",
  );
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
  if (!desc) return "";
  const text = desc.trim();
  const b = String(bank || "").toUpperCase();

  // 1. Bank Syariah Indonesia (BSI)
  if (b === "BSI") {
    const match = text.match(
      /(?:TRF|TRANSFER)\s+(?:CR\s+)?DARI\s+\d+\s+([A-Z\s\.\,\'\-]+)/i,
    );
    if (match) return cleanNameToken(match[1]);
  }

  // 2. Bank Central Asia (BCA)
  if (b === "BCA") {
    const match = text.match(
      /TRSF\s+E-BANKING\s+CR\s+[^\s]+\s+([A-Z\s\.\,\'\-]+)/i,
    );
    if (match) return cleanNameToken(match[1]);
  }

  // 3. Bank Mandiri
  if (b === "MANDIRI") {
    const match = text.match(
      /(?:TRANSFER|TRF)\s+DARI\s+\d+\s+(?:AN|A\/N)?\s*([A-Z\s\.\,\'\-]+)/i,
    );
    if (match) return cleanNameToken(match[1]);
  }

  // 4. Bank Negara Indonesia (BNI)
  if (b === "BNI") {
    // Robust pattern handling optional BI-FAST and DARI BNI indicators
    const match = text.match(
      /(?:TRF|TRANSFER)\s+(?:BI-FAST\s+)?(?:CR\s+)?DARI\s+(?:BNI\s+)?(?:\d+\s+)?([A-Z\s\.\,\'\-]+)/i,
    );
    if (match) return cleanNameToken(match[1]);
  }

  // 5. Bank Rakyat Indonesia (BRI)
  if (b === "BRI") {
    const match = text.match(
      /(?:TRANSFER|TRF)\s+(?:BRIMO\s+)?DARI\s+\d+\s+([A-Z\s\.\,\'\-]+)/i,
    );
    if (match) return cleanNameToken(match[1]);
  }

  // Generic fallback pattern
  const genericMatch = text.match(
    /(?:DARI|FROM|AN|A\/N)\s+([A-Z\s\.\,\'\-]+)/i,
  );
  if (genericMatch) {
    return cleanNameToken(genericMatch[1]);
  }

  return "";
}

/**
 * Determines donation program based on description keyword matching.
 *
 * @param {string} description - Raw narration.
 * @param {Array<{keyword: string, program: string}>} keywordList - Keyword dictionary.
 * @returns {string} Detected program, defaults to 'Umum'.
 */
function detectProgram(description, keywordList) {
  if (!description || !keywordList || keywordList.length === 0) return "Umum";
  const upper = description.toUpperCase();
  for (let i = 0; i < keywordList.length; i++) {
    if (upper.indexOf(keywordList[i].keyword) !== -1) {
      return keywordList[i].program;
    }
  }
  return "Umum";
}

/**
 * Core 3-tier transaction matching engine.
 *
 * Tier 1: Exact reference code [AG]\d{6} present in transfer description.
 * Tier 2: Exactly ONE active donation intent matching bank, exact amount, and within time window.
 * Tier 3: Ambiguous or no match -> Route to Admin Review Queue.
 *
 * @param {Object} tx - Incoming mutation object {bank, amount, description, tx_date}.
 * @param {Object} context - {usersByRefCode: Map, pendingIntents: Array, windowHours: number, now: Date}.
 * @returns {Object} Match result {status: 'MATCHED'|'UNMATCHED', tier: 1|2|3, user: Object|null, intent: Object|null, reason: string}.
 */
function matchTransaction(tx, context) {
  const usersByRef = context.usersByRefCode || new Map();
  const pendingIntents = context.pendingIntents || [];
  const windowHours = context.windowHours || 24;
  const now = context.now ? new Date(context.now) : new Date();

  // Tier 1: Check reference code in description
  const refCodeInDesc = extractRefCode(tx.description);
  if (refCodeInDesc && usersByRef.has(refCodeInDesc)) {
    const user = usersByRef.get(refCodeInDesc);
    // Find if there is a pending intent for this user with matching bank and amount
    let matchedIntent = null;
    for (let i = 0; i < pendingIntents.length; i++) {
      const it = pendingIntents[i];
      if (
        it.ref_code === refCodeInDesc &&
        it.bank === tx.bank &&
        Math.abs(it.amount - tx.amount) < 0.01
      ) {
        matchedIntent = it;
        break;
      }
    }
    return {
      status: "MATCHED",
      tier: 1,
      ref_code: refCodeInDesc,
      user_id: user.user_id,
      user: user,
      intent_id: matchedIntent ? matchedIntent.intent_id : null,
      intent: matchedIntent,
      reason: "Matched via explicit reference code in description",
    };
  }

  // Tier 2: Check matching pending intents by Bank + Exact Amount + Within Time Window
  const candidates = [];
  const windowMs = windowHours * 60 * 60 * 1000;

  for (let i = 0; i < pendingIntents.length; i++) {
    const intent = pendingIntents[i];
    // Must match bank and amount
    if (intent.bank === tx.bank && Math.abs(intent.amount - tx.amount) < 0.01) {
      const intentCreatedAt = new Date(intent.created_at).getTime();
      const diff = Math.abs(now.getTime() - intentCreatedAt);
      if (diff <= windowMs) {
        candidates.push(intent);
      }
    }
  }

  // Tier 2 succeeds ONLY if exactly ONE candidate is found
  if (candidates.length === 1) {
    const singleIntent = candidates[0];
    const user = usersByRef.get(singleIntent.ref_code) || null;
    return {
      status: "MATCHED",
      tier: 2,
      ref_code: singleIntent.ref_code,
      user_id: user ? user.user_id : singleIntent.user_id,
      user: user,
      intent_id: singleIntent.intent_id,
      intent: singleIntent,
      reason:
        "Matched uniquely via Bank + Amount within " + windowHours + "h window",
    };
  }

  // Tier 3: Multiple candidates (collision) or no candidate found
  const reason =
    candidates.length > 1
      ? "Ambiguous match: " +
        candidates.length +
        " intents share bank (" +
        tx.bank +
        ") and amount (" +
        tx.amount +
        ")"
      : "No reference code in note and no matching intent found";

  return {
    status: "UNMATCHED",
    tier: 3,
    ref_code: null,
    user_id: null,
    user: null,
    intent_id: null,
    intent: null,
    candidates_count: candidates.length,
    reason: reason,
  };
}

/**
 * Currency formatter for IDR.
 *
 * @param {number} num - Raw amount.
 * @returns {string} E.g., Rp 500.000.
 */
function formatRupiah(num) {
  const parts = Math.round(num || 0)
    .toString()
    .split("");
  let formatted = "";
  let count = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    formatted = parts[i] + formatted;
    count++;
    if (count % 3 === 0 && i !== 0) {
      formatted = "." + formatted;
    }
  }
  return "Rp " + formatted;
}

// Export for Node.js test environment if available
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SUPPORTED_BANKS,
    formatRefCode,
    extractRefCode,
    maskDonorName,
    maskAccountNumber,
    cleanNameToken,
    parseDonorName,
    detectProgram,
    matchTransaction,
    formatRupiah,
  };
}
