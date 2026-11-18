/**
 * Tests.gs
 * Self-test suite to be executed directly inside the Google Apps Script editor.
 * Tests ref code logic, privacy masking, bank parsers, and tier 1-2 matching.
 */

function runSelfTests() {
  Logger.log("--- STARTING SELF TESTS FOR DONASIALUMNIAPP ---");
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      Logger.log("✅ PASS: " + message);
      passed++;
    } else {
      Logger.log("❌ FAIL: " + message);
      failed++;
    }
  }

  // 1. Ref Code Tests
  assert(
    formatRefCode("A", 471) === "A000471",
    "Alumni sequence 471 formats to A000471",
  );
  assert(
    formatRefCode("G", 12) === "G000012",
    "Guest sequence 12 formats to G000012",
  );
  assert(
    extractRefCode("DONASI A000471 BEASISWA") === "A000471",
    "Extracts A000471 from string",
  );
  assert(
    extractRefCode("INFAQ G000012 OLEH TAMU") === "G000012",
    "Extracts G000012 from string",
  );

  // 2. Masking Tests (OPEN-02 three-state separation)
  assert(
    maskDonorName("") === "Pengirim Tidak Tercatat",
    "Empty parsed donor name defaults to Pengirim Tidak Tercatat",
  );
  assert(
    maskDonorName("Ahmad Rizki", true) === "Seseorang",
    "Explicit anonymous donor renders as Seseorang",
  );
  assert(
    maskDonorName("Ahmad Rizki", false) === "A***d R.",
    "Masks Ahmad Rizki -> A***d R.",
  );
  assert(
    maskDonorName("Siti Nurhaliza Putri") === "S***i N.",
    "Masks Siti Nurhaliza Putri -> S***i N.",
  );
  assert(
    maskAccountNumber("7129384756") === "71****56",
    "Masks account number to 71****56",
  );

  // 3. Multi-bank parser tests
  assert(
    parseDonorName(
      "BCA",
      "TRSF E-BANKING CR 0811/FTSCY/WS95031 AHMAD RIZKI BEASISWA",
    ) === "AHMAD RIZKI",
    "BCA donor parser",
  );
  assert(
    parseDonorName(
      "BSI",
      "TRF CR DARI 1234567890 MUHAMMAD RAFI DONASI BEASISWA",
    ) === "MUHAMMAD RAFI",
    "BSI donor parser",
  );
  assert(
    parseDonorName(
      "MANDIRI",
      "TRANSFER DARI 1370012345678 AN SITI NURHALIZA INFAQ",
    ) === "SITI NURHALIZA",
    "Mandiri donor parser",
  );
  assert(
    parseDonorName(
      "BNI",
      "TRF BI-FAST CR DARI BNI 987654321 DIMAS ANUGRAH BEASISWA",
    ) === "DIMAS ANUGRAH",
    "BNI donor parser",
  );
  assert(
    parseDonorName(
      "BRI",
      "TRANSFER BRIMO DARI 001201000123500 FARHAN ADITYA BEASISWA",
    ) === "FARHAN ADITYA",
    "BRI donor parser",
  );

  // 4. Matcher Tier 1 & 2 tests
  const mockUsers = new Map([
    [
      "A000471",
      {
        user_id: "usr_1",
        ref_code: "A000471",
        email: "ahmad@upi.edu",
        full_name: "Ahmad",
      },
    ],
  ]);
  const baseTime = new Date();

  // Tier 1 Match
  const t1 = matchTransaction(
    {
      bank: "BCA",
      amount: 100000,
      description: "TRSF CR A000471 BEASISWA",
    },
    {
      usersByRefCode: mockUsers,
      pendingIntents: [],
      windowHours: 24,
      now: baseTime,
    },
  );
  assert(
    t1.status === "MATCHED" && t1.tier === 1,
    "Tier 1 matched via ref code",
  );

  // Tier 2 Match
  const t2 = matchTransaction(
    {
      bank: "BSI",
      amount: 500000,
      description: "TRF CR DARI BSI NO REF",
    },
    {
      usersByRefCode: mockUsers,
      pendingIntents: [
        {
          intent_id: "int_1",
          ref_code: "A000471",
          bank: "BSI",
          amount: 500000,
          created_at: baseTime,
        },
      ],
      windowHours: 24,
      now: baseTime,
    },
  );
  assert(
    t2.status === "MATCHED" && t2.tier === 2,
    "Tier 2 matched uniquely via intent",
  );

  // 5. P1 Stabilization Tests: Non-account Guest Tier 1, Expired, Already Paid, & Anti-False-Match
  const tGuest = matchTransaction(
    {
      bank: "BCA",
      amount: 150000,
      description: "PEMBAYARAN VA 390122000099 DONASI",
    },
    {
      usersByRefCode: mockUsers,
      pendingIntents: [
        {
          intent_id: "int_guest_1",
          user_id: "",
          ref_code: "G000099",
          bank: "BCA",
          amount: 150000,
          status: "PENDING",
          created_at: baseTime,
          donor_name: "Tamu Non Akun",
          donor_email: "guest@example.com",
        },
      ],
      windowHours: 24,
      now: baseTime,
    },
  );
  assert(
    tGuest.status === "MATCHED" && tGuest.tier === 1 && tGuest.intent_id === "int_guest_1",
    "Tier 1 matches non-account Guest via donation_intents without users record",
  );

  const tExpired = matchTransaction(
    {
      bank: "BCA",
      amount: 150000,
      description: "PEMBAYARAN VA 390122000099 DONASI",
    },
    {
      usersByRefCode: mockUsers,
      pendingIntents: [
        {
          intent_id: "int_exp_1",
          ref_code: "G000099",
          bank: "BCA",
          amount: 150000,
          status: "PENDING",
          created_at: new Date(baseTime.getTime() - 48 * 3600 * 1000),
          expires_at: new Date(baseTime.getTime() - 24 * 3600 * 1000),
        },
      ],
      windowHours: 24,
      now: baseTime,
    },
  );
  assert(
    tExpired.status === "UNMATCHED" && tExpired.tier === 3,
    "Expired intent is never auto-matched",
  );

  const tAlreadyPaid = matchTransaction(
    {
      bank: "BCA",
      amount: 150000,
      description: "PEMBAYARAN VA 390122000099 DONASI",
    },
    {
      usersByRefCode: mockUsers,
      pendingIntents: [
        {
          intent_id: "int_paid_1",
          ref_code: "G000099",
          bank: "BCA",
          amount: 150000,
          status: "MATCHED",
          created_at: baseTime,
        },
      ],
      windowHours: 24,
      now: baseTime,
    },
  );
  assert(
    tAlreadyPaid.status === "UNMATCHED" && tAlreadyPaid.tier === 3,
    "Already paid intent is routed to UNMATCHED review queue",
  );

  const tAlumniMismatch = matchTransaction(
    {
      bank: "BCA",
      amount: 100000,
      description: "TRSF CR A000471 BEASISWA",
    },
    {
      usersByRefCode: mockUsers,
      pendingIntents: [
        {
          intent_id: "int_alu_500k",
          ref_code: "A000471",
          bank: "BCA",
          amount: 500000,
          status: "PENDING",
          created_at: baseTime,
        },
      ],
      windowHours: 24,
      now: baseTime,
    },
  );
  assert(
    tAlumniMismatch.status === "MATCHED" && tAlumniMismatch.intent_id === null,
    "Alumni ref_code with different nominal does not false-close pending 500k intent",
  );

  // Test Group 8: P5 Midtrans Hybrid State Machine & Channel Normalization
  const sigInput = buildMidtransSignatureInput("DON-A000471-123", "200", "150000.00", "SB-Mid-server-test");
  assert(
    sigInput === "DON-A000471-123200150000.00SB-Mid-server-test",
    "buildMidtransSignatureInput preserves exact gross_amount decimal string",
  );
  assert(
    normalizeMidtransChannel({ payment_type: "bank_transfer", va_numbers: [{ bank: "bca" }] }) === "MIDTRANS_BCA" &&
      normalizeMidtransChannel({ payment_type: "echannel" }) === "MIDTRANS_MANDIRI" &&
      normalizeMidtransChannel({ payment_type: "qris" }) === "MIDTRANS_QRIS",
    "normalizeMidtransChannel maps VA, Mandiri echannel, and QRIS accurately",
  );
  const st404 = mapMidtransTransactionState("not_found_404", "");
  const stChallenge = mapMidtransTransactionState("capture", "challenge");
  const stSettle = mapMidtransTransactionState("settlement", "accept");
  const stRefund = mapMidtransTransactionState("refund", "");
  assert(
    st404.intent_status === "PENDING" &&
      stChallenge.intent_status === "PENDING" &&
      !stChallenge.should_finalize_tx &&
      stSettle.intent_status === "MATCHED" &&
      stSettle.should_finalize_tx &&
      stRefund.is_reversal === true &&
      stRefund.gateway_status === "REFUNDED",
    "mapMidtransTransactionState enforces 404/challenge hold, settlement finalization, and in-place reversal",
  );

  Logger.log(`--- SELF TESTS FINISHED: ${passed} Passed, ${failed} Failed ---`);
}
