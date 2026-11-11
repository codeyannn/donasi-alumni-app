/**
 * Setup.gs
 * Schema and initial configuration builder for DonasiAlumniApp.
 */

var SHEET_NAMES = SHEET_NAMES || {
  USERS: "users",
  VERIFICATIONS: "alumni_verifications",
  INTENTS: "donation_intents",
  TRANSACTIONS: "transactions",
  REVIEW_QUEUE: "review_queue",
  COUNTERS: "counters",
  AUDIT_LOG: "audit_log",
  CONFIG: "config",
  KEYWORDS: "program_keywords",
};

/**
 * Initializes all required sheets, columns, formatting, and default configurations.
 * Run once from Apps Script editor.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      "Tidak dapat mendeteksi Spreadsheet aktif. Buka Apps Script dari menu Extensions > Apps Script.",
    );
  }

  // 1. users sheet
  const userHeaders = [
    "user_id",
    "google_sub",
    "email",
    "full_name",
    "role", // ALUMNI, GUEST, ADMIN
    "ref_code", // A000471 or G000012
    "verification_status", // NONE, PENDING, VERIFIED, REJECTED
    "consent_at",
    "created_at",
  ];
  initSheetWithHeaders_(ss, SHEET_NAMES.USERS, userHeaders);

  // 2. alumni_verifications sheet
  const verifHeaders = [
    "verif_id",
    "user_id",
    "email",
    "full_name",
    "nim",
    "grad_year",
    "faculty",
    "proof_file_id",
    "status", // PENDING, VERIFIED, REJECTED
    "submitted_at",
    "reviewed_by",
    "reviewed_at",
    "reject_reason",
  ];
  initSheetWithHeaders_(ss, SHEET_NAMES.VERIFICATIONS, verifHeaders);

  // 3. donation_intents sheet
  const intentHeaders = [
    "intent_id",
    "user_id",
    "ref_code",
    "amount",
    "bank",
    "program",
    "status", // PENDING, MATCHED, EXPIRED
    "created_at",
    "expires_at",
    "matched_tx_id",
  ];
  initSheetWithHeaders_(ss, SHEET_NAMES.INTENTS, intentHeaders);

  // 4. transactions sheet
  const txHeaders = [
    "tx_id",
    "mutation_id",
    "received_at",
    "bank",
    "account_masked",
    "tx_date",
    "amount",
    "description", // Stored safely in private spreadsheet
    "donor_name_raw",
    "donor_display_name",
    "match_status", // MATCHED, UNMATCHED, MANUAL_MATCHED
    "match_tier", // 1 (Ref Code), 2 (Unique Intent), 3 (Review Queue)
    "user_id",
    "ref_code",
    "intent_id",
    "program",
    "is_anonymous",
  ];
  initSheetWithHeaders_(ss, SHEET_NAMES.TRANSACTIONS, txHeaders);

  // 5. review_queue sheet
  const queueHeaders = [
    "queue_id",
    "tx_id",
    "bank",
    "amount",
    "tx_date",
    "description",
    "reason",
    "candidates_count",
    "status", // PENDING, RESOLVED, IGNORED
    "resolved_by",
    "resolved_at",
    "assigned_user_id",
    "assigned_ref_code",
  ];
  initSheetWithHeaders_(ss, SHEET_NAMES.REVIEW_QUEUE, queueHeaders);

  // 6. counters sheet
  const counterHeaders = ["name", "value"];
  const counterSheet = initSheetWithHeaders_(
    ss,
    SHEET_NAMES.COUNTERS,
    counterHeaders,
  );
  if (counterSheet.getLastRow() <= 1) {
    counterSheet.getRange(2, 1, 2, 2).setValues([
      ["ALUMNI", 0],
      ["GUEST", 0],
    ]);
  }

  // 7. audit_log sheet
  const auditHeaders = [
    "timestamp",
    "actor_email",
    "action",
    "target",
    "detail",
  ];
  initSheetWithHeaders_(ss, SHEET_NAMES.AUDIT_LOG, auditHeaders);

  // 8. config sheet
  const cfgHeaders = ["key", "value", "description"];
  const cfgSheet = initSheetWithHeaders_(ss, SHEET_NAMES.CONFIG, cfgHeaders);
  if (cfgSheet.getLastRow() <= 1) {
    const defaultConfigs = [
      [
        "WEBHOOK_TOKEN",
        "ALUMNI_UPI_SECRET_TOKEN_2026",
        "Token query parameter for bank webhook calls",
      ],
      [
        "ADMIN_EMAILS",
        "maulanaa1408@upi.edu",
        "Comma separated emails of system admins",
      ],
      [
        "MATCH_WINDOW_HOURS",
        "24",
        "Hours window to consider an intent valid for tier 2 auto-match",
      ],
      [
        "ORG_NAME",
        "Pengelola Beasiswa Ikatan Alumni UPI",
        "Organization title displayed on app & emails",
      ],
      [
        "GOOGLE_CLIENT_ID",
        "",
        "Optional Google Client ID for backend audience verification",
      ],
    ];
    cfgSheet.getRange(2, 1, defaultConfigs.length, 3).setValues(defaultConfigs);
  }

  // 9. program_keywords sheet
  const kwHeaders = ["keyword", "program"];
  const kwSheet = initSheetWithHeaders_(ss, SHEET_NAMES.KEYWORDS, kwHeaders);
  if (kwSheet.getLastRow() <= 1) {
    const defaultKeywords = [
      ["BEASISWA", "Beasiswa Alumni UPI"],
      ["PRESTASI", "Beasiswa Prestasi"],
      ["AFIRMASI", "Beasiswa Afirmasi"],
      ["WAKAF", "Wakaf Pendidikan"],
      ["ZAKAT", "Zakat Pendidikan"],
      ["INFAQ", "Infaq Operasional"],
      ["SEDEKAH", "Infaq & Sedekah"],
    ];
    kwSheet
      .getRange(2, 1, defaultKeywords.length, 2)
      .setValues(defaultKeywords);
  }

  Logger.log("Setup completed successfully for DonasiAlumniApp.");
}

/**
 * Helper to ensure a tab exists with bold styled headers and frozen first row.
 */
function initSheetWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet
    .getRange(1, 1, 1, headers.length)
    .setFontWeight("bold")
    .setBackground("#E2E8F0");
  sheet.setFrozenRows(1);
  return sheet;
}
