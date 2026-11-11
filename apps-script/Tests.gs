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

  // 2. Masking Tests
  assert(
    maskDonorName("") === "Seseorang",
    "Empty donor name defaults to Seseorang",
  );
  assert(
    maskDonorName("Ahmad Rizki") === "A***d R.",
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

  Logger.log(`--- SELF TESTS FINISHED: ${passed} Passed, ${failed} Failed ---`);
}
