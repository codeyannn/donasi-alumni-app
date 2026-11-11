/**
 * config.js
 * Configuration variables for DonasiAlumniApp frontend.
 */

const CONFIG = {
  // Replace with your Apps Script Web App executable URL once deployed
  API_URL:
    window.localStorage.getItem("DONASI_API_URL") ||
    "https://script.google.com/macros/s/AKfycbyuSQ1FXKOcP454WkbQAHKL1ug3z4r5Mc3jygRZS3UcEdfG2aHG1v5XOFa_eWMGwEa_/exec",

  // Google OAuth 2.0 Web Client ID
  GOOGLE_CLIENT_ID:
    window.localStorage.getItem("DONASI_GOOGLE_CLIENT_ID") ||
    "898950675801-uinvgp6i049kg01pp4qjcdkcchnoqiri.apps.googleusercontent.com",

  // Fallback demo mode flag
  DEMO_MODE: !window.localStorage.getItem("DONASI_API_URL"),
};
