// Fill these 2 values from Supabase: Project Settings -> API
// (the "anon public" key is meant to be public. NEVER put the service_role key or Razorpay secret here.)
window.YAARI_CONFIG = {
  SUPABASE_URL: "https://fxcniggsmzfsjazkkpwo.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_kdbWLIxlq5E-9m5hgt4uiw_qezabjBB",

  // Turn on once your SMS provider (and India DLT registration) is ready.
  REQUIRE_PHONE_OTP: false,

  // ID photo upload is required before an account goes for review.
  REQUIRE_ID_UPLOAD: true,

  // Real names of your Edge Functions in Supabase (change only if Supabase gave them random names)
  FUNCTIONS: {
    "create-order": "hyper-worker",
    "verify-payment": "hyper-worker",
    "refund-booking": "hyper-worker"
  },

  // Your business details. They appear on the Terms, Privacy, Refund and Contact pages.
  BUSINESS: {
    name: "YOUR BUSINESS NAME",
    address: "YOUR FULL ADDRESS, Kolkata, West Bengal, PIN",
    email: "YOUR SUPPORT EMAIL",
    phone: "YOUR PHONE NUMBER",
    grievanceOfficer: "YOUR NAME",
    city: "Kolkata",
    effective: "9 October 2026"
  }
};
