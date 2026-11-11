/**
 * api.js
 * API communication layer with Google Apps Script backend and offline mock fallbacks.
 */

const API = {
  /**
   * Performs GET request to Apps Script Web App.
   */
  async get(action, params = {}) {
    if (CONFIG.DEMO_MODE || !CONFIG.API_URL) {
      return this.mockGet(action, params);
    }
    const query = new URLSearchParams({ action, ...params });
    const res = await fetch(`${CONFIG.API_URL}?${query.toString()}`);
    return await res.json();
  },

  /**
   * Performs POST request to Apps Script Web App.
   */
  async post(action, data = {}) {
    if (CONFIG.DEMO_MODE || !CONFIG.API_URL) {
      return this.mockPost(action, data);
    }
    const res = await fetch(
      `${CONFIG.API_URL}?action=${encodeURIComponent(action)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      },
    );
    return await res.json();
  },

  /**
   * Mock GET dispatcher for testing UI offline.
   */
  mockGet(action, params) {
    if (action === "public_summary") {
      return Promise.resolve({
        status: "ok",
        org_name: "Pengelola Beasiswa Ikatan Alumni UPI",
        total_amount: 18500000,
        formatted_total: "Rp 18.500.000",
        total_count: 24,
        today_amount: 1500000,
        formatted_today: "Rp 1.500.000",
        by_bank: {
          BSI: 6500000,
          MANDIRI: 4000000,
          BCA: 5000000,
          BNI: 2000000,
          BRI: 1000000,
        },
        by_program: {
          "Beasiswa Alumni UPI": 12000000,
          "Wakaf Pendidikan": 3500000,
          "Infaq Operasional": 3000000,
        },
        recent_donations: [
          {
            date: "2026-11-11",
            bank: "BCA",
            amount: 500000,
            formatted_amount: "Rp 500.000",
            donor: "A***d R.",
            is_alumni: true,
            program: "Beasiswa Alumni UPI",
          },
          {
            date: "2026-11-11",
            bank: "BSI",
            amount: 1000000,
            formatted_amount: "Rp 1.000.000",
            donor: "M***d R.",
            is_alumni: true,
            program: "Beasiswa Alumni UPI",
          },
          {
            date: "2026-11-10",
            bank: "MANDIRI",
            amount: 250000,
            formatted_amount: "Rp 250.000",
            donor: "S***i N.",
            is_alumni: false,
            program: "Infaq Operasional",
          },
        ],
      });
    }

    if (action === "my_donations") {
      const storedUser = JSON.parse(
        window.localStorage.getItem("DONASI_USER") || "{}",
      );
      return Promise.resolve({
        status: "ok",
        user: storedUser,
        summary: {
          total_donated: 1500000,
          formatted_total: "Rp 1.500.000",
          total_count: 2,
          by_bank: { BCA: 1000000, BSI: 500000 },
        },
        active_intents: [
          {
            intent_id: "INT_DEMO_01",
            ref_code: storedUser.ref_code || "A000471",
            amount: 500000,
            formatted_amount: "Rp 500.000",
            bank: "BCA",
            program: "Beasiswa Alumni UPI",
            created_at: new Date().toISOString(),
          },
        ],
        history: [
          {
            type: "TRANSACTION",
            id: "TX_DEMO_01",
            date: "2026-11-10",
            bank: "BCA",
            amount: 1000000,
            formatted_amount: "Rp 1.000.000",
            program: "Beasiswa Alumni UPI",
            match_status: "MATCHED",
            ref_code: storedUser.ref_code,
          },
          {
            type: "TRANSACTION",
            id: "TX_DEMO_02",
            date: "2026-11-05",
            bank: "BSI",
            amount: 500000,
            formatted_amount: "Rp 500.000",
            program: "Wakaf Pendidikan",
            match_status: "MATCHED",
            ref_code: storedUser.ref_code,
          },
        ],
      });
    }

    if (action === "admin_verifications") {
      return Promise.resolve({
        status: "ok",
        items: [
          {
            verif_id: "VRF_DEMO_01",
            email: "alumni.baru@upi.edu",
            full_name: "Farhan Aditya",
            nim: "1904521",
            grad_year: "2023",
            faculty: "FPMIPA",
            status: "PENDING",
            submitted_at: "2026-11-11",
          },
          {
            verif_id: "VRF_DEMO_02",
            email: "ahmad.rizki@upi.edu",
            full_name: "Ahmad Rizki",
            nim: "1802134",
            grad_year: "2022",
            faculty: "FIP",
            status: "VERIFIED",
            reviewed_by: "maulanaa1408@upi.edu",
          },
        ],
      });
    }

    if (action === "admin_queue") {
      return Promise.resolve({
        status: "ok",
        items: [
          {
            queue_id: "REV_DEMO_01",
            tx_id: "TX_UNMATCHED_01",
            bank: "BCA",
            amount: 100000,
            formatted_amount: "Rp 100.000",
            tx_date: "2026-11-11 09:30:00",
            description: "TRSF CR BCA TANPA REF",
            reason:
              "Ambiguous match: 2 intents share bank (BCA) and amount (100000)",
            status: "PENDING",
          },
        ],
      });
    }

    if (action === "admin_insights") {
      return Promise.resolve({
        status: "ok",
        total_amount: 18500000,
        formatted_total: "Rp 18.500.000",
        total_count: 24,
        tier_distribution: { 1: 16, 2: 6, 3: 2, MANUAL: 1 },
        bank_breakdown: {
          BSI: 6500000,
          BCA: 5000000,
          MANDIRI: 4000000,
          BNI: 2000000,
          BRI: 1000000,
        },
        demographics: {
          registered_alumni: 45,
          verified_alumni: 38,
          guests: 12,
        },
      });
    }

    return Promise.resolve({ status: "ok" });
  },

  /**
   * Mock POST dispatcher.
   */
  mockPost(action, data) {
    if (action === "register_or_login") {
      const role = data.role || "GUEST";
      const refCode =
        role === "GUEST" ? "G000012" : role === "ADMIN" ? "A000001" : "";
      const user = {
        user_id: "USR_DEMO_" + Date.now().toString().slice(-4),
        email: data.email || "demo@upi.edu",
        full_name: data.name || "Demo User",
        role: role,
        ref_code: refCode,
        verification_status: role === "ALUMNI" ? "NONE" : "VERIFIED",
      };
      window.localStorage.setItem("DONASI_USER", JSON.stringify(user));
      return Promise.resolve({ status: "ok", user });
    }

    if (action === "submit_verification") {
      const user = JSON.parse(
        window.localStorage.getItem("DONASI_USER") || "{}",
      );
      user.verification_status = "PENDING";
      window.localStorage.setItem("DONASI_USER", JSON.stringify(user));
      return Promise.resolve({
        status: "ok",
        verif_id: "VRF_DEMO_NEW",
        verification_status: "PENDING",
      });
    }

    if (action === "create_intent") {
      const user = JSON.parse(
        window.localStorage.getItem("DONASI_USER") || "{}",
      );
      return Promise.resolve({
        status: "ok",
        intent_id: "INT_" + Date.now().toString().slice(-6),
        ref_code: user.ref_code || "A000471",
        bank: data.bank,
        amount: data.amount,
        formatted_amount: "Rp " + Number(data.amount).toLocaleString("id-ID"),
        transfer_instruction: {
          target_bank: data.bank,
          amount: data.amount,
          transfer_note: user.ref_code || "A000471",
          note_instruction: `PENTING: Tuliskan kode referensi "${user.ref_code || "A000471"}" pada berita transfer m-banking Anda.`,
        },
      });
    }

    if (action === "review_verification") {
      return Promise.resolve({
        status: "ok",
        decision: data.approve ? "VERIFIED" : "REJECTED",
      });
    }

    if (action === "resolve_queue") {
      return Promise.resolve({
        status: "ok",
        assigned_ref_code: data.target_ref_code,
      });
    }

    return Promise.resolve({ status: "ok" });
  },
};
