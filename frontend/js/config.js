/**
 * config.js
 * Configuration variables for DonasiAlumniApp frontend.
 */

const CONFIG = {
  // Replace with your Apps Script Web App executable URL once deployed
  API_URL:
    window.localStorage.getItem("DONASI_API_URL") ||
    "https://script.google.com/macros/s/AKfycbzakVJ_bNRhhH2tQeS6tBINU-5BiNFvQzOuVhcmSO0ouGkNioKzfN1dYmZKT8VJQiLEKg/exec",

  // Google OAuth 2.0 Web Client ID
  GOOGLE_CLIENT_ID:
    window.localStorage.getItem("DONASI_GOOGLE_CLIENT_ID") ||
    "898950675801-uinvgp6i049kg01pp4qjcdkcchnoqiri.apps.googleusercontent.com",

  // Midtrans Sandbox Client Key (override via localStorage during staging QA without hardcoding secrets)
  MIDTRANS_CLIENT_KEY:
    window.localStorage.getItem("DONASI_MIDTRANS_CLIENT_KEY") || "SB-Mid-client-Mid-client-Ymk5FCF4NHxo-sa8",

  // Midtrans Snap JS endpoint (defaults to Sandbox)
  MIDTRANS_SNAP_URL:
    window.localStorage.getItem("DONASI_MIDTRANS_SNAP_URL") ||
    "https://app.sandbox.midtrans.com/snap/snap.js",

  // Set default to false so real Google Sheets & Apps Script backend is called
  DEMO_MODE: false,
};
