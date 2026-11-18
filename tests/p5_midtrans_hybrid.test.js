/**
 * p5_midtrans_hybrid.test.js
 * Comprehensive verification suite for Phase P5 (Midtrans Hybrid Payment:
 * Pure SHA-512 & State Mappers, Snap Token Creation, Dual-Mode Webhook + Throttled Active Inquiry,
 * Self-Healing Write-Ahead Finalizer, Isolated Email State, One-Way Terminal Protection, & In-Place Reversal).
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
 * Helper to compute SHA-512 hex in Node.js test assertions.
 */
function sha512HexNode(input) {
  return crypto.createHash("sha512").update(String(input), "utf8").digest("hex");
}

/**
 * Builds an isolated GAS V8 VM harness with V2 migrated schema and programmable Midtrans HTTP mock.
 */
function createP5Harness(options = {}) {
  const sheets = {};
  const scriptProps = {
    EXPECTED_STAGING_SPREADSHEET_ID: "STAGING_P5_TEST_SS_ID",
    GOOGLE_CLIENT_ID: "898950675801-testclient.apps.googleusercontent.com",
    ADMIN_EMAILS: "maulanaa1408@upi.edu",
    WEBHOOK_MANUAL_SECRET: "p5_test_hmac_secret_32bytes_value",
    TOKEN_PEPPER: "p5_test_pepper_32bytes_secret_value",
    MIDTRANS_SERVER_KEY: "SB-Mid-server-P5_UNIT_TEST_SECRET_KEY",
    MIDTRANS_IS_PRODUCTION: "false",
    ALLOW_MOCK_AUTH: "false",
    ...(options.props || {}),
  };
  const scriptCache = {};
  const userCache = {};
  const sentEmails = [];
  const tokenDirectory = {};
  const midtransSnapRequests = [];
  const midtransInquiryRequests = [];
  const midtransStatusByOrderId = {};
  let snapHttpMock = null;
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

  const ssId = options.ssId || "STAGING_P5_TEST_SS_ID";
  const ssName = options.ssName || "STAGING_P5_TestDB";
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
          throw new Error("Simulated MailApp daily quota exceeded");
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
    },
    UrlFetchApp: {
      fetch: (url, fetchOpts = {}) => {
        // 1. Google OAuth tokeninfo mock
        if (url.indexOf("oauth2.googleapis.com/tokeninfo") !== -1) {
          const qIdx = url.indexOf("id_token=");
          const tok = qIdx >= 0 ? decodeURIComponent(url.slice(qIdx + "id_token=".length)) : "";
          const rec = tokenDirectory[tok];
          if (!rec) return { getResponseCode: () => 401, getContentText: () => "{}" };
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify(rec) };
        }

        // 2. Midtrans Snap token creation endpoint
        if (url.indexOf("/snap/v1/transactions") !== -1) {
          const parsedBody = JSON.parse(fetchOpts.payload || "{}");
          midtransSnapRequests.push({ url, headers: fetchOpts.headers, body: parsedBody });
          if (typeof snapHttpMock === "function") {
            return snapHttpMock(parsedBody, fetchOpts);
          }
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

        // 3. Midtrans Core API GET /v2/{order_id}/status endpoint
        const statusMatch = url.match(/\/v2\/([^/]+)\/status$/);
        if (statusMatch) {
          const orderId = decodeURIComponent(statusMatch[1]);
          midtransInquiryRequests.push({ url, orderId, headers: fetchOpts.headers });
          const mocked = midtransStatusByOrderId[orderId];
          if (!mocked || mocked.http_status === 404) {
            return {
              getResponseCode: () => 404,
              getContentText: () =>
                JSON.stringify({
                  status_code: "404",
                  status_message: "Transaction doesn't exist.",
                }),
            };
          }
          return {
            getResponseCode: () => mocked.http_status || 200,
            getContentText: () => JSON.stringify(mocked),
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
    midtransSnapRequests,
    midtransInquiryRequests,
    midtransStatusByOrderId,
    setSnapHttpMock: (fn) => {
      snapHttpMock = fn;
    },
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
    signMidtransWebhook: (payload, overrideKey) => {
      const key = overrideKey !== undefined ? overrideKey : scriptProps.MIDTRANS_SERVER_KEY;
      const sig = sha512HexNode(
        String(payload.order_id) + String(payload.status_code) + String(payload.gross_amount) + String(key)
      );
      return { ...payload, signature_key: sig };
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

  console.log("💳 RUNNING PHASE P5 MIDTRANS HYBRID PAYMENT TESTS...\n");

  test("Pure Midtrans Functions: SHA-512 signature, constant-time verify, channel normalizer, & 4-State Machine mapper", () => {
    const h = createP5Harness();
    const {
      extractRefCodeFromOrderId,
      buildMidtransSignatureInput,
      verifyMidtransSignature,
      normalizeMidtransChannel,
      mapMidtransTransactionState,
      computeSha512Hex_,
    } = h.sandbox;

    assert.strictEqual(extractRefCodeFromOrderId("DON-A000471-1A2B3C"), "A000471");
    assert.strictEqual(extractRefCodeFromOrderId("DON-G000019-9F8E7D"), "G000019");

    const raw = buildMidtransSignatureInput("DON-A000471-XYZ", "200", "250000.00", "SB-Mid-server-123");
    assert.strictEqual(raw, "DON-A000471-XYZ200250000.00SB-Mid-server-123");

    const validSig = computeSha512Hex_(raw);
    assert.strictEqual(validSig.length, 128);
    assert.strictEqual(
      verifyMidtransSignature(
        { order_id: "DON-A000471-XYZ", status_code: "200", gross_amount: "250000.00", signature_key: validSig.toUpperCase() },
        "SB-Mid-server-123",
        computeSha512Hex_
      ),
      true
    );
    assert.strictEqual(
      verifyMidtransSignature(
        { order_id: "DON-A000471-XYZ", status_code: "200", gross_amount: "250000", signature_key: validSig },
        "SB-Mid-server-123",
        computeSha512Hex_
      ),
      false,
      "Decimal difference in gross_amount must fail signature verification"
    );

    assert.strictEqual(normalizeMidtransChannel({ payment_type: "bank_transfer", va_numbers: [{ bank: "bni" }] }), "MIDTRANS_BNI");
    assert.strictEqual(normalizeMidtransChannel({ payment_type: "bank_transfer", permata_va_number: "123" }), "MIDTRANS_PERMATA");
    assert.strictEqual(normalizeMidtransChannel({ payment_type: "echannel" }), "MIDTRANS_MANDIRI");
    assert.strictEqual(normalizeMidtransChannel({ payment_type: "qris" }), "MIDTRANS_QRIS");

    assert.strictEqual(mapMidtransTransactionState("not_found_404").intent_status, "PENDING");
    assert.strictEqual(mapMidtransTransactionState("capture", "challenge").should_finalize_tx, false);
    assert.strictEqual(mapMidtransTransactionState("capture", "accept").should_finalize_tx, true);
    assert.strictEqual(mapMidtransTransactionState("settlement").gateway_status, "SETTLED");
    assert.strictEqual(mapMidtransTransactionState("expire").intent_status, "EXPIRED");
    assert.strictEqual(mapMidtransTransactionState("cancel").intent_status, "CANCELLED");
    assert.strictEqual(mapMidtransTransactionState("deny").intent_status, "FAILED");
    assert.strictEqual(mapMidtransTransactionState("refund").is_reversal, true);
  });

  test("Snap Token Creation (Alumni & Guest): Basic Auth, anonymity masking, OPEN-03 fee=0, & ScriptProperties-only ServerKey", () => {
    const h = createP5Harness();
    h.registerOAuth("tok_admin", { sub: "sub_adm", email: "maulanaa1408@upi.edu", name: "Admin" });
    h.registerOAuth("tok_alu", { sub: "sub_alu", email: "alumni@upi.edu", name: "Budi Santoso" });

    // Register Admin & Alumni, then approve Alumni
    h.post({ action: "register_or_login", id_token: "tok_admin", role: "ALUMNI", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_alu", role: "ALUMNI", consent: true });
    const subV = h.post({
      action: "submit_verification",
      id_token: "tok_alu",
      nim: "2408647",
      grad_year: "2024",
      faculty: "FPMIPA",
      file_name: "ijazah.pdf",
      file_mime: "application/pdf",
      file_base64: Buffer.from("%PDF-1.4 mock proof").toString("base64"),
    });
    h.post({ action: "review_verification", id_token: "tok_admin", verif_id: subV.verif_id, decision: "APPROVED" });

    // 1. Alumni Snap Intent (with explicit anonymity = true)
    const aluIntent = h.post({
      action: "create_intent",
      id_token: "tok_alu",
      amount: 175000,
      payment_channel: "MIDTRANS_SNAP",
      program_id: "PRG-002",
      is_anonymous: true,
    });
    assert.strictEqual(aluIntent.status, "ok");
    assert.match(aluIntent.snap_token, /^SNAP_TOK_DON-A\d{6}-/);
    assert.strictEqual(aluIntent.payment_mode, "MIDTRANS_SANDBOX_ACTIVE");
    assert.strictEqual(aluIntent.gross_amount, 175000);
    assert.strictEqual(aluIntent.gateway_fee, 0);
    assert.strictEqual(aluIntent.net_amount, 175000);
    assert.strictEqual(h.midtransSnapRequests[0].body.customer_details.first_name, "Seseorang (Anonim)");
    assert.ok(!JSON.stringify(aluIntent).includes("SB-Mid-server"), "ServerKey must never leak in response");

    // 2. Accountless Guest Snap Intent
    const guestIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Rina Tamu",
      donor_email: "rina@example.com",
      amount: 200000,
      program_id: "PRG-001",
      payment_channel: "MIDTRANS_SNAP",
      is_anonymous: false,
      consent: true,
    });
    assert.strictEqual(guestIntent.status, "ok");
    assert.ok(guestIntent.snap_token.startsWith("SNAP_TOK_DON-G000001-"));
    assert.ok(guestIntent.access_token && guestIntent.access_token.length === 64);

    // 3. ServerKey in config sheet must be ignored if ScriptProperties.MIDTRANS_SERVER_KEY is deleted
    delete h.scriptProps.MIDTRANS_SERVER_KEY;
    h.sheets.config.appendRow(["MIDTRANS_SERVER_KEY", "SHEET_FALLBACK_MUST_BE_IGNORED", "Should never be read"]);
    assert.throws(
      () => h.sandbox.getMidtransConfig_({ requireServerKey: true }),
      /MIDTRANS_SERVER_KEY belum dikonfigurasi/,
      "ServerKey must never fall back to config sheet"
    );
  });

  test("Midtrans Webhook Security, Challenge Hold, Settlement Finalizer, Idempotency, & One-Way Terminal Protection", () => {
    const h = createP5Harness();
    const guestIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Donatur Snap",
      donor_email: "snapdonor@example.com",
      amount: 300000,
      program_id: "PRG-004",
      payment_channel: "MIDTRANS_SNAP",
      is_anonymous: false,
      consent: true,
    });
    const orderId = guestIntent.order_id;

    // 1. Reject forged SHA-512 signature
    const badSigRes = h.post(
      h.signMidtransWebhook(
        { order_id: orderId, status_code: "200", gross_amount: "300000.00", transaction_status: "settlement" },
        "WRONG_SERVER_KEY"
      )
    );
    assert.strictEqual(badSigRes.status, "error");
    assert.ok(badSigRes.message.includes("Invalid Midtrans signature_key"));

    // 2. Reject gross_amount tampering even with valid signature for that tampered amount
    const badAmtRes = h.post(
      h.signMidtransWebhook({
        order_id: orderId,
        status_code: "200",
        gross_amount: "10000.00",
        transaction_status: "settlement",
      })
    );
    assert.strictEqual(badAmtRes.status, "error");
    assert.ok(badAmtRes.message.includes("gross_amount mismatch"));

    // 3. Capture with fraud_status='challenge' holds intent in PENDING and issues ZERO receipt
    const challengeRes = h.post(
      h.signMidtransWebhook({
        order_id: orderId,
        status_code: "201",
        gross_amount: "300000.00",
        transaction_status: "capture",
        fraud_status: "challenge",
        payment_type: "credit_card",
      })
    );
    assert.strictEqual(challengeRes.status, "ok");
    assert.strictEqual(challengeRes.intent_status, "PENDING");
    assert.strictEqual(challengeRes.gateway_status, "CHALLENGE");
    assert.strictEqual(challengeRes.receipt_no, "");
    assert.strictEqual(h.sheets.transactions.getLastRow(), 1, "No transaction row written during challenge");

    // 4. Settlement webhook records 35-col transaction, mints KWT receipt, closes intent, and sends email
    const settlePayload = h.signMidtransWebhook({
      order_id: orderId,
      transaction_id: "MID_TX_001",
      status_code: "200",
      gross_amount: "300000.00",
      transaction_status: "settlement",
      fraud_status: "accept",
      payment_type: "bank_transfer",
      va_numbers: [{ bank: "bca", va_number: "123456" }],
      settlement_time: "2026-11-18 09:00:00",
    });
    const settleRes = h.post(settlePayload);
    assert.strictEqual(settleRes.status, "ok");
    assert.strictEqual(settleRes.action_taken, "confirmed_and_recorded");
    assert.strictEqual(settleRes.intent_status, "MATCHED");
    assert.strictEqual(settleRes.gateway_status, "SETTLED");
    assert.match(settleRes.receipt_no, /^KWT-\d{4}-000001$/);
    assert.strictEqual(settleRes.email_status, "SENT");
    assert.strictEqual(h.sheets.transactions.getLastRow(), 2);

    // 5. Duplicate settlement webhook is strictly idempotent (zero extra rows, zero extra emails)
    const emailCountAfterFirst = h.sentEmails.length;
    const dupRes = h.post(settlePayload);
    assert.strictEqual(dupRes.status, "ok");
    assert.strictEqual(dupRes.duplicate, true);
    assert.strictEqual(dupRes.receipt_no, settleRes.receipt_no);
    assert.strictEqual(h.sheets.transactions.getLastRow(), 2);
    assert.strictEqual(h.sentEmails.length, emailCountAfterFirst);

    // 6. Late out-of-order pending or expire webhook NEVER downgrades MATCHED intent
    const latePending = h.post(
      h.signMidtransWebhook({
        order_id: orderId,
        status_code: "201",
        gross_amount: "300000.00",
        transaction_status: "pending",
      })
    );
    assert.strictEqual(latePending.action_taken, "noop_already_matched");
    assert.strictEqual(latePending.intent_status, "MATCHED");

    const lateExpire = h.post(
      h.signMidtransWebhook({
        order_id: orderId,
        status_code: "407",
        gross_amount: "300000.00",
        transaction_status: "expire",
      })
    );
    assert.strictEqual(lateExpire.action_taken, "noop_already_matched");
    assert.strictEqual(lateExpire.intent_status, "MATCHED");
  });

  test("Self-Healing Write-Ahead Recovery & Isolated Email Failure (State Machine 4)", () => {
    const h = createP5Harness();
    const gIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Self Heal Donor",
      donor_email: "heal@example.com",
      amount: 120000,
      program_id: "PRG-001",
      payment_channel: "MIDTRANS_SNAP",
      is_anonymous: false,
      consent: true,
    });

    // Simulate MailApp outage during settlement webhook -> transaction MUST still commit as MATCHED with email_status='FAILED'
    h.setMailShouldThrow(true);
    const settleWithMailFail = h.post(
      h.signMidtransWebhook({
        order_id: gIntent.order_id,
        transaction_id: "MID_TX_FAILMAIL",
        status_code: "200",
        gross_amount: "120000.00",
        transaction_status: "settlement",
        payment_type: "qris",
      })
    );
    assert.strictEqual(settleWithMailFail.status, "ok");
    assert.strictEqual(settleWithMailFail.intent_status, "MATCHED");
    assert.strictEqual(settleWithMailFail.email_status, "FAILED");
    assert.match(settleWithMailFail.receipt_no, /^KWT-\d{4}-000001$/);

    const tMap = h.sandbox.getHeaderMap_(h.sheets.transactions);
    const txRow = h.sheets.transactions.getDataRange().getValues()[1];
    assert.strictEqual(txRow[tMap.email_status], "FAILED");
    assert.ok(String(txRow[tMap.email_error]).includes("MailApp"));

    // Simulate interrupted partial execution: revert intent row back to PENDING with empty matched_tx_id while transaction row exists
    const iMap = h.sandbox.getHeaderMap_(h.sheets.donation_intents);
    h.sheets.donation_intents.getRange(2, iMap.status + 1).setValue("PENDING");
    h.sheets.donation_intents.getRange(2, iMap.matched_tx_id + 1).setValue("");

    // Re-send settlement webhook -> must self-heal intent to MATCHED without adding a 2nd transaction row!
    const healRes = h.post(
      h.signMidtransWebhook({
        order_id: gIntent.order_id,
        transaction_id: "MID_TX_FAILMAIL",
        status_code: "200",
        gross_amount: "120000.00",
        transaction_status: "settlement",
        payment_type: "qris",
      })
    );
    assert.strictEqual(healRes.status, "ok");
    assert.strictEqual(healRes.self_healed, true);
    assert.strictEqual(healRes.action_taken, "self_healed_intent");
    assert.strictEqual(h.sheets.transactions.getLastRow(), 2, "Must not duplicate transaction row during self-heal");

    const healedIntentRow = h.sheets.donation_intents.getDataRange().getValues()[1];
    assert.strictEqual(healedIntentRow[iMap.status], "MATCHED");
    assert.strictEqual(healedIntentRow[iMap.matched_tx_id], settleWithMailFail.tx_id);
  });

  test("Dual-Mode Active Status Inquiry (404 Hold, 5s Throttle, Auto-Finalize) & Admin Sync + In-Place Refund", () => {
    const h = createP5Harness();
    h.registerOAuth("tok_admin", { sub: "sub_adm", email: "maulanaa1408@upi.edu", name: "Admin" });
    h.registerOAuth("tok_nonadmin", { sub: "sub_u", email: "user@upi.edu", name: "User" });
    h.post({ action: "register_or_login", id_token: "tok_admin", role: "ALUMNI", consent: true });
    h.post({ action: "register_or_login", id_token: "tok_nonadmin", role: "ALUMNI", consent: true });

    const gIntent = h.post({
      action: "create_guest_intent",
      donor_name: "Inquiry Donor",
      donor_email: "inq@example.com",
      amount: 150000,
      program_id: "PRG-005",
      payment_channel: "MIDTRANS_SNAP",
      is_anonymous: false,
      consent: true,
    });
    const orderId = gIntent.order_id;

    // 1. Initial check_intent when Midtrans returns 404 (customer hasn't picked payment channel yet) -> stays PENDING
    const poll1 = h.post({
      action: "check_intent",
      intent_id: gIntent.intent_id,
      access_token: gIntent.access_token,
    });
    assert.strictEqual(poll1.intent_status, "PENDING");
    assert.strictEqual(poll1.gateway_status, "NOT_FOUND_404");
    assert.strictEqual(h.midtransInquiryRequests.length, 1);

    // 2. Immediate second check_intent within < 5s is throttled via last_inquiry_at
    h.midtransStatusByOrderId[orderId] = {
      http_status: 200,
      status_code: "200",
      order_id: orderId,
      transaction_id: "MID_INQ_01",
      gross_amount: "150000.00",
      transaction_status: "settlement",
      fraud_status: "accept",
      payment_type: "echannel",
    };
    const pollThrottled = h.post({
      action: "check_intent",
      intent_id: gIntent.intent_id,
      access_token: gIntent.access_token,
    });
    assert.strictEqual(pollThrottled.intent_status, "PENDING", "Should throttle inquiry within 5s window");
    assert.strictEqual(h.midtransInquiryRequests.length, 1);

    // 3. Backdate last_inquiry_at by 6s -> check_intent queries Midtrans and finalizes transaction immediately
    const iMap = h.sandbox.getHeaderMap_(h.sheets.donation_intents);
    h.sheets.donation_intents
      .getRange(2, iMap.last_inquiry_at + 1)
      .setValue(new Date(Date.now() - 6000).toISOString());

    const pollSettled = h.post({
      action: "check_intent",
      intent_id: gIntent.intent_id,
      access_token: gIntent.access_token,
    });
    assert.strictEqual(pollSettled.intent_status, "MATCHED");
    assert.strictEqual(pollSettled.gateway_status, "SETTLED");
    assert.match(pollSettled.receipt_no, /^KWT-\d{4}-000001$/);
    assert.strictEqual(h.midtransInquiryRequests.length, 2);

    // Verify public summary includes the settled Rp 150.000 transaction
    const pubBeforeRefund = h.get({ action: "public_summary" });
    assert.strictEqual(pubBeforeRefund.total_amount, 150000);
    assert.strictEqual(pubBeforeRefund.total_count, 1);

    // 4. Non-admin blocked from admin_check_midtrans; Admin can sync & handle in-place REFUND
    const unauthSync = h.post({ action: "admin_check_midtrans", id_token: "tok_nonadmin", intent_id: gIntent.intent_id });
    assert.strictEqual(unauthSync.status, "error");
    assert.ok(unauthSync.message.includes("Forbidden"));

    h.midtransStatusByOrderId[orderId] = {
      http_status: 200,
      status_code: "200",
      order_id: orderId,
      transaction_id: "MID_INQ_01",
      gross_amount: "150000.00",
      transaction_status: "refund",
      payment_type: "echannel",
    };
    const adminSyncRefund = h.post({
      action: "admin_check_midtrans",
      id_token: "tok_admin",
      intent_id: gIntent.intent_id,
    });
    assert.strictEqual(adminSyncRefund.status, "ok");
    assert.strictEqual(adminSyncRefund.gateway_status, "REFUNDED");
    assert.strictEqual(h.sheets.transactions.getLastRow(), 2, "Refund must update in-place without adding or deleting rows");

    // Verify refunded transaction is excluded from public verified donation totals
    const pubAfterRefund = h.get({ action: "public_summary" });
    assert.strictEqual(pubAfterRefund.total_amount, 0);
    assert.strictEqual(pubAfterRefund.total_count, 0);
  });

  console.log(`\n==========================================\nP5 MIDTRANS HYBRID SUITE: ${passed} Passed, ${failed} Failed\n==========================================`);
  if (failed > 0) process.exit(1);
}

runTests();
