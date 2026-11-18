/**
 * p6_receipt_notification.test.js
 * Comprehensive verification suite for Phase P6 (Official Receipt Issuance KWT-YYYY-000001,
 * Post-Confirmation Exclusivity, Anti-IDOR Ownership & Guest Token Verification,
 * Reversal Blocking, State Machine 4 Email Tracking, Idempotent retry_tx_email, & Receipt UI).
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const GAS_DIR = path.join(ROOT_DIR, "apps-script");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");

/**
 * Computes HMAC-SHA256 signature for manual bank webhook requests.
 */
function signManualWebhook(rawPayloadStr, timestampSec, nonce, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestampSec}.${nonce}.${rawPayloadStr}`, "utf8")
    .digest("hex");
}

/**
 * Builds an isolated GAS V8 VM harness with V2 migrated schema and Receipts.gs loaded.
 */
function createP6Harness(options = {}) {
  const sheets = {};
  const scriptProps = {
    EXPECTED_STAGING_SPREADSHEET_ID: "STAGING_P6_TEST_SS_ID",
    GOOGLE_CLIENT_ID: "898950675801-testclient.apps.googleusercontent.com",
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
    WEBHOOK_MANUAL_SECRET: "p6_test_hmac_secret_32bytes_value",
    TOKEN_PEPPER: "p6_test_pepper_32bytes_secret_value",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-P6_UNIT_TEST_SECRET_KEY",
    MIDTRANS_IS_PRODUCTION: "false",
    ALLOW_MOCK_AUTH: "false",
    ...(options.props || {}),
  };
  const scriptCache = {};
  const userCache = {};
  const sentEmails = [];
  const tokenDirectory = {};
  let mailShouldThrow = false;

  function makeSheet(name) {
    const rows = [];
    const sheetObj = {
      getName: () => name,
      getLastRow: () => rows.length,
      getLastColumn: () => {
        let maxC = 0;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].length > maxC) maxC = rows[i].length;
        }
        return maxC;
      },
      appendRow: (row) => rows.push([...row]),
      deleteRow: (rowIdx1) => {
        if (rowIdx1 >= 1 && rowIdx1 <= rows.length) {
          rows.splice(rowIdx1 - 1, 1);
        }
      },
      clearContents: () => {
        rows.length = 0;
      },
      getDataRange: () => ({ getValues: () => rows.map((r) => [...r]) }),
      getRange: (startRow, startCol, numRows = 1, numCols = 1) => ({
        getValues: () => {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const rowArr = rows[startRow - 1 + r] || [];
            const slice = [];
            for (let c = 0; c < numCols; c++) {
              const val = rowArr[startCol - 1 + c];
              slice.push(val === undefined ? "" : val);
            }
            out.push(slice);
          }
          return out;
        },
        getValue: () => {
          const rowArr = rows[startRow - 1] || [];
          const val = rowArr[startCol - 1];
          return val === undefined ? "" : val;
        },
        setValue: (val) => {
          while (rows.length < startRow) rows.push([]);
          while (rows[startRow - 1].length < startCol) rows[startRow - 1].push("");
          rows[startRow - 1][startCol - 1] = val;
        },
        setValues: (matrix) => {
          for (let r = 0; r < matrix.length; r++) {
            const targetR = startRow - 1 + r;
            while (rows.length <= targetR) rows.push([]);
            for (let c = 0; c < matrix[r].length; c++) {
              const targetC = startCol - 1 + c;
              while (rows[targetR].length <= targetC) rows[targetR].push("");
              rows[targetR][targetC] = matrix[r][c];
            }
          }
        },
        setFontWeight: () => sheetObj.getRange(startRow, startCol, numRows, numCols),
        setBackground: () => sheetObj.getRange(startRow, startCol, numRows, numCols),
      }),
      setFrozenRows: () => {},
      _rows: rows,
    };
    return sheetObj;
  }

  const ssId = options.ssId || "STAGING_P6_TEST_SS_ID";
  const ssName = options.ssName || "STAGING_P6_TestDB";
  const ss = {
    getId: () => ssId,
    getName: () => ssName,
    getSheets: () => Object.values(sheets),
    getSheetByName: (name) => sheets[name] || null,
    insertSheet: (name) => {
      sheets[name] = makeSheet(name);
      return sheets[name];
    },
    deleteSheet: (s) => {
      const n = typeof s === "string" ? s : s.getName();
      delete sheets[n];
    },
  };

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
        setProperty: (k, v) => {
          scriptProps[k] = String(v);
        },
        deleteProperty: (k) => {
          delete scriptProps[k];
        },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in scriptCache ? scriptCache[k] : null),
        put: (k, v) => {
          scriptCache[k] = String(v);
        },
        remove: (k) => {
          delete scriptCache[k];
        },
      }),
      getUserCache: () => ({
        get: (k) => (k in userCache ? userCache[k] : null),
        put: (k, v) => {
          userCache[k] = String(v);
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {},
        releaseLock: () => {},
      }),
    },
    MailApp: {
      sendEmail: (obj) => {
        if (mailShouldThrow) {
          throw new Error("Simulated MailApp SMTP failure");
        }
        sentEmails.push(obj);
      },
    },
    DriveApp: {
      Access: { ANYONE: "ANYONE", PRIVATE: "PRIVATE" },
      Permission: { NONE: "NONE", VIEW: "VIEW" },
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({
        setSharing: () => {},
        createFile: () => ({
          getId: () => "DRV_FILE_" + crypto.randomUUID().slice(0, 6),
          setSharing: () => {},
        }),
      }),
      getFileById: () => ({
        setTrashed: () => {},
        getBlob: () => ({ getBytes: () => [1, 2, 3], getContentType: () => "application/pdf", getName: () => "ijazah.pdf" }),
      }),
    },
    Utilities: {
      DigestAlgorithm: { MD5: "MD5", SHA_256: "SHA_256", SHA_512: "SHA_512" },
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => new Date(d).toISOString().replace("T", " ").substring(0, 19),
      base64Encode: (input) => {
        if (Array.isArray(input)) {
          return Buffer.from(input.map((b) => (b < 0 ? b + 256 : b))).toString("base64");
        }
        return Buffer.from(String(input), "utf8").toString("base64");
      },
      base64Decode: (b64) => Array.from(Buffer.from(String(b64 || ""), "base64")),
      newBlob: (bytes, mime, name) => ({ getBytes: () => bytes, getContentType: () => mime, getName: () => name }),
      computeDigest: (algo, input) => {
        const alg = algo === "SHA_256" ? "sha256" : algo === "SHA_512" ? "sha512" : "md5";
        const buf = crypto.createHash(alg).update(String(input), "utf8").digest();
        return Array.from(buf).map((b) => (b >= 128 ? b - 256 : b));
      },
      computeHmacSha256Signature: (msg, key) => {
        const buf = crypto.createHmac("sha256", String(key)).update(String(msg), "utf8").digest();
        return Array.from(buf).map((b) => (b >= 128 ? b - 256 : b));
      },
    },
    UrlFetchApp: {
      fetch: (url, fetchOpts = {}) => {
        if (url.indexOf("oauth2.googleapis.com/tokeninfo") !== -1) {
          const qIdx = url.indexOf("id_token=");
          const tok = qIdx >= 0 ? decodeURIComponent(url.slice(qIdx + "id_token=".length)) : "";
          const rec = tokenDirectory[tok];
          if (!rec) return { getResponseCode: () => 401, getContentText: () => "{}" };
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify(rec) };
        }
        if (url.indexOf("/snap/v1/transactions") !== -1) {
          const parsedBody = JSON.parse(fetchOpts.payload || "{}");
          const oid = parsedBody.transaction_details.order_id;
          return {
            getResponseCode: () => 201,
            getContentText: () =>
              JSON.stringify({
                token: "SNAP_TOK_" + oid,
                redirect_url: "https://app.sandbox.midtrans.com/snap/v4/redirection/SNAP_TOK_" + oid,
              }),
          };
        }
        return { getResponseCode: () => 404, getContentText: () => "{}" };
      },
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (str) => ({
        setMimeType: () => {},
        getContent: () => str,
      }),
    },
    Logger: { log: () => {} },
  };

  vm.createContext(sandbox);
  const files = [
    "Setup.gs",
    "Logic.gs",
    "AuditLog.gs",
    "Auth.gs",
    "Notifier.gs",
    "Programs.gs",
    "Payments.gs",
    "Receipts.gs",
    "Users.gs",
    "Donations.gs",
    "Webhook.gs",
    "Admin.gs",
    "PublicApi.gs",
    "Code.gs",
  ];
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), "utf8"), sandbox, { filename: f });
  }

  sandbox.setupSheets();
  sandbox.migrateDatabaseNonDestructive({ dryRun: false, autoBackup: false, backupVerified: true });

  return {
    ss,
    sandbox,
    sheets,
    scriptProps,
    sentEmails,
    setMailShouldThrow: (val) => {
      mailShouldThrow = Boolean(val);
    },
    registerOAuth: (token, claims) => {
      tokenDirectory[token] = {
        aud: scriptProps.GOOGLE_CLIENT_ID,
        email_verified: "true",
        ...claims,
      };
    },
    post: (bodyObj) => {
      const res = sandbox.doPost({ postData: { contents: JSON.stringify(bodyObj) }, parameter: {} });
      return JSON.parse(res.getContent());
    },
    get: (params) => {
      const res = sandbox.doGet({ parameter: params });
      return JSON.parse(res.getContent());
    },
    sendManualWebhook: (mutationsArr) => {
      const rawPayload = JSON.stringify(mutationsArr);
      const ts = Math.floor(Date.now() / 1000);
      const nonce = "nonce_" + crypto.randomUUID();
      const hmac = signManualWebhook(rawPayload, ts, nonce, scriptProps.WEBHOOK_MANUAL_SECRET);
      return sandbox.doPost({
        postData: {
          contents: JSON.stringify({
            webhook_auth: { timestamp: ts, nonce: nonce, signature: hmac },
            payload_raw: rawPayload,
          }),
        },
        parameter: {},
      });
    },
  };
}

function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}\n     ${err.stack || err.message}`);
      failed++;
    }
  }

  console.log("🧾 RUNNING PHASE P6 RECEIPT & NOTIFICATION V2 TESTS...\n");

  test("Post-Confirmation Exclusive KWT Issuance: MATCHED mints receipt, UNMATCHED keeps empty until Admin resolve_queue", () => {
    const h = createP6Harness();
    h.registerOAuth("tok_admin", { sub: "sub_adm", email: "maulanaa1408@upi.edu", name: "Admin" });
    h.post({ action: "register_or_login", id_token: "tok_admin", role: "ALUMNI", consent: true });

    // Create Guest manual transfer intent (G000001)
    const gIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Siti Aminah",
      donor_email: "siti@example.com",
      amount: 250000,
      program_id: "PRG-002",
      payment_channel: "MANUAL_TRANSFER",
      bank: "BCA",
      is_anonymous: false,
      consent: true,
    });
    assert.strictEqual(gIntent.status, "ok");

    // 1. Send 1 MATCHED mutation (carrying G000001) and 1 UNMATCHED mutation (unknown sender/amount)
    const whOut = JSON.parse(
      h.sendManualWebhook([
        {
          mutation_id: "MUT_P6_MATCHED_1",
          bank: "BCA",
          amount: 250000,
          type: "CR",
          description: `TRSF E-BANKING CR ${gIntent.ref_code} SITI AMINAH`,
          transaction_date: "2026-11-18 09:10:00",
        },
        {
          mutation_id: "MUT_P6_UNMATCHED_1",
          bank: "BRI",
          amount: 333000,
          type: "CR",
          description: "TRANSFER TANPA REFERENSI",
          transaction_date: "2026-11-18 09:11:00",
        },
      ]).getContent()
    );
    assert.strictEqual(whOut.matched, 1);
    assert.strictEqual(whOut.unmatched, 1);

    const tMap = h.sandbox.getHeaderMap_(h.sheets.transactions);
    const tRows = h.sheets.transactions.getDataRange().getValues();
    const matchedTxRow = tRows[1];
    const unmatchedTxRow = tRows[2];

    // Verify MATCHED row got KWT-YYYY-000001 and email_status='SENT'
    assert.match(String(matchedTxRow[tMap.receipt_no]), /^KWT-\d{4}-000001$/);
    assert.strictEqual(matchedTxRow[tMap.email_status], "SENT");

    // Verify UNMATCHED row has strictly empty receipt_no and email_status='NOT_APPLICABLE'
    assert.strictEqual(unmatchedTxRow[tMap.receipt_no], "");
    assert.strictEqual(unmatchedTxRow[tMap.email_status], "NOT_APPLICABLE");

    // Verify get_receipt blocks UNMATCHED transaction even for Admin
    const unmatchedTxId = unmatchedTxRow[tMap.tx_id];
    const blockedUnmatched = h.post({
      action: "get_receipt",
      id_token: "tok_admin",
      tx_id: unmatchedTxId,
    });
    assert.strictEqual(blockedUnmatched.status, "error");
    assert.ok(blockedUnmatched.message.includes("belum terkonfirmasi"));

    // 2. Admin resolves UNMATCHED review_queue item to G000001 -> mints KWT-YYYY-000002 & sends email
    const qList = h.post({ action: "admin_queue", id_token: "tok_admin" });
    assert.strictEqual(qList.items.length, 1);
    const resolved = h.post({
      action: "resolve_queue",
      id_token: "tok_admin",
      queue_id: qList.items[0].queue_id,
      target_ref_code: gIntent.ref_code,
    });
    assert.strictEqual(resolved.status, "ok");
    assert.match(resolved.receipt_no, /^KWT-\d{4}-000002$/);
    assert.strictEqual(resolved.email_status, "SENT");
  });

  test("Anti-IDOR Receipt Ownership (Alumni, Guest 256-bit Token, Admin), Anonymity, & OPEN-03 Sandbox Disclosure", () => {
    const h = createP6Harness();
    h.registerOAuth("tok_admin", { sub: "sub_adm", email: "maulanaa1408@upi.edu", name: "Admin" });
    h.registerOAuth("tok_alu1", { sub: "sub_a1", email: "alu1@upi.edu", name: "Alumni Satu" });
    h.registerOAuth("tok_alu2", { sub: "sub_a2", email: "alu2@upi.edu", name: "Alumni Dua" });

    h.post({ action: "register_or_login", id_token: "tok_admin", role: "ALUMNI", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_alu1", role: "ALUMNI", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_alu2", role: "ALUMNI", consent: true });

    const v1 = h.post({
      action: "submit_verification",
      id_token: "tok_alu1",
      nim: "2401111",
      grad_year: "2024",
      faculty: "FPMIPA",
      file_name: "ijazah.pdf",
      file_mime: "application/pdf",
      file_base64: Buffer.from("%PDF-1.4 valid").toString("base64"),
    });
    h.post({ action: "review_verification", id_token: "tok_admin", verif_id: v1.verif_id, decision: "APPROVED" });

    // Alumni 1 creates anonymous manual intent and simulates payment
    const aluIntent = h.post({
      action: "create_intent",
      id_token: "tok_alu1",
      amount: 500000,
      payment_channel: "MANUAL_TRANSFER",
      bank: "BSI",
      program_id: "PRG-004",
      is_anonymous: true,
    });
    h.post({ action: "simulate_manual_payment", id_token: "tok_alu1", intent_id: aluIntent.intent_id });

    const myDon = h.post({ action: "my_donations", id_token: "tok_alu1" });
    assert.strictEqual(myDon.history.length, 1);
    const aluTxId = myDon.history[0].tx_id;
    const aluReceiptNo = myDon.history[0].receipt_no;
    assert.match(aluReceiptNo, /^KWT-\d{4}-000001$/);

    // 1. Unauthenticated request (OPEN-04: no token) must be rejected
    const noAuth = h.post({ action: "get_receipt", tx_id: aluTxId, ref_code: aluIntent.ref_code });
    assert.strictEqual(noAuth.status, "error");
    assert.ok(noAuth.message.includes("Authentication required"));

    // 2. Alumni 2 (non-owner) is blocked from reading Alumni 1's receipt
    const crossUser = h.post({ action: "get_receipt", id_token: "tok_alu2", tx_id: aluTxId });
    assert.strictEqual(crossUser.status, "error");
    assert.ok(crossUser.message.includes("Forbidden"));

    // 3. Alumni 1 (owner) retrieves official receipt with anonymous label & Sandbox notice (OPEN-03)
    const ownReceipt = h.post({ action: "get_receipt", id_token: "tok_alu1", tx_id: aluTxId });
    assert.strictEqual(ownReceipt.status, "ok");
    assert.strictEqual(ownReceipt.receipt.receipt_no, aluReceiptNo);
    assert.strictEqual(ownReceipt.receipt.donor_name, "Seseorang (Donatur Anonim)");
    assert.strictEqual(ownReceipt.receipt.gross_amount, 500000);
    assert.strictEqual(ownReceipt.receipt.gateway_fee, 0);
    assert.strictEqual(ownReceipt.receipt.net_amount, 500000);
    assert.strictEqual(ownReceipt.receipt.is_sandbox, true);
    assert.ok(ownReceipt.receipt.environment_notice.includes("Mode Sandbox"));

    // 4. Guest checkout + receipt retrieval via 256-bit access_token (and rejection on wrong token)
    const gIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Tamu Kuitansi",
      donor_email: "tamukwt@example.com",
      amount: 100000,
      program_id: "PRG-003",
      payment_channel: "MANUAL_TRANSFER",
      bank: "MANDIRI",
      is_anonymous: false,
      consent: true,
    });
    h.post({
      action: "simulate_manual_payment",
      intent_id: gIntent.intent_id,
      access_token: gIntent.access_token,
    });

    const badGuestReceipt = h.post({
      action: "get_receipt",
      ref_code: gIntent.ref_code,
      access_token: "0".repeat(64),
    });
    assert.strictEqual(badGuestReceipt.status, "error");
    assert.ok(badGuestReceipt.message.includes("Forbidden"));

    const okGuestReceipt = h.post({
      action: "get_receipt",
      ref_code: gIntent.ref_code,
      access_token: gIntent.access_token,
    });
    assert.strictEqual(okGuestReceipt.status, "ok");
    assert.match(okGuestReceipt.receipt.receipt_no, /^KWT-\d{4}-000002$/);
    assert.strictEqual(okGuestReceipt.receipt.donor_name, "Tamu Kuitansi");
  });

  test("Reversal Blocking (REFUNDED) & State Machine 4 Idempotent retry_tx_email", () => {
    const h = createP6Harness();
    h.registerOAuth("tok_admin", { sub: "sub_adm", email: "maulanaa1408@upi.edu", name: "Admin" });
    h.registerOAuth("tok_user", { sub: "sub_u", email: "user@upi.edu", name: "User" });
    h.post({ action: "register_or_login", id_token: "tok_admin", role: "ALUMNI", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_user", role: "ALUMNI", consent: true });

    const gIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Retry Donor",
      donor_email: "retry@example.com",
      amount: 150000,
      program_id: "PRG-001",
      payment_channel: "MANUAL_TRANSFER",
      bank: "BNI",
      is_anonymous: false,
      consent: true,
    });

    // 1. Simulate MailApp failure during confirmation -> transaction is MATCHED with KWT receipt, email_status='FAILED'
    h.setMailShouldThrow(true);
    h.post({
      action: "simulate_manual_payment",
      intent_id: gIntent.intent_id,
      access_token: gIntent.access_token,
    });

    const tMap = h.sandbox.getHeaderMap_(h.sheets.transactions);
    const txRow = h.sheets.transactions.getDataRange().getValues()[1];
    const txId = txRow[tMap.tx_id];
    assert.strictEqual(txRow[tMap.email_status], "FAILED");
    assert.ok(String(txRow[tMap.email_error]).includes("SMTP failure"));

    // 2. Non-admin blocked from retry_tx_email
    const nonAdminRetry = h.post({ action: "retry_tx_email", id_token: "tok_user", tx_id: txId });
    assert.strictEqual(nonAdminRetry.status, "error");
    assert.ok(nonAdminRetry.message.includes("Forbidden"));

    // 3. Restore MailApp and run Admin retry_tx_email -> transitions FAILED -> SENT and clears email_error
    h.setMailShouldThrow(false);
    const retryOk = h.post({ action: "retry_tx_email", id_token: "tok_admin", tx_id: txId });
    assert.strictEqual(retryOk.status, "ok");
    assert.strictEqual(retryOk.email_status, "SENT");
    assert.ok(retryOk.email_sent_at);
    assert.strictEqual(retryOk.email_error, "");

    // 4. Second retry_tx_email when already SENT is rejected (idempotency guard against donor spam)
    const retryDup = h.post({ action: "retry_tx_email", id_token: "tok_admin", tx_id: txId });
    assert.strictEqual(retryDup.status, "error");
    assert.ok(retryDup.message.includes("sudah berstatus SENT"));

    // 5. Mark transaction as REFUNDED -> get_receipt must block access to voided receipt
    h.sheets.transactions.getRange(2, tMap.gateway_status + 1).setValue("REFUNDED");
    const refundedReceipt = h.post({
      action: "get_receipt",
      ref_code: gIntent.ref_code,
      access_token: gIntent.access_token,
    });
    assert.strictEqual(refundedReceipt.status, "error");
    assert.ok(refundedReceipt.message.includes("REFUNDED"));
  });

  test("Frontend Receipt Page (receipt.html, receipt.js, & @media print CSS) Verification", () => {
    const html = fs.readFileSync(path.join(FRONTEND_DIR, "receipt.html"), "utf8");
    const js = fs.readFileSync(path.join(FRONTEND_DIR, "js", "receipt.js"), "utf8");
    const css = fs.readFileSync(path.join(FRONTEND_DIR, "css", "style.css"), "utf8");

    assert.ok(html.includes('id="receiptDocumentCard"'), "receipt.html must include printable receipt container");
    assert.ok(html.includes('src="js/receipt.js"'), "receipt.html must load js/receipt.js");
    assert.ok(js.includes("API.post('get_receipt'"), "receipt.js must fetch receipt via POST body");
    assert.ok(js.includes("window.location.hash"), "receipt.js must read Guest credentials from URL #fragment");
    assert.ok(js.includes("window.sessionStorage"), "receipt.js must persist Guest session in sessionStorage");
    assert.ok(!js.includes("window.localStorage.setItem(RECEIPT_GUEST_SESSION_KEY"), "Guest token must never be stored in localStorage");
    assert.ok(css.includes("@media print"), "style.css must define @media print rules for clean PDF printing");

    // Verify GET get_receipt and GET retry_tx_email are rejected with 405
    const h = createP6Harness();
    const getBlocked1 = h.get({ action: "get_receipt" });
    const getBlocked2 = h.get({ action: "retry_tx_email" });
    assert.strictEqual(getBlocked1.status, "error");
    assert.strictEqual(getBlocked2.status, "error");
    assert.ok(getBlocked1.message.includes("POST"));
    assert.ok(getBlocked2.message.includes("POST"));
  });

  console.log(`\n==========================================\nP6 RECEIPT & NOTIFICATION SUITE: ${passed} Passed, ${failed} Failed\n==========================================`);
  if (failed > 0) process.exit(1);
}

runTests();
