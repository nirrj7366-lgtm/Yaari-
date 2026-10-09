(function () {
"use strict";
var cfg = window.YAARI_CONFIG;
var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

/* ---------- helpers ---------- */
var $ = function (i) { return document.getElementById(i); };
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function rs(n) { return "₹" + Number(n || 0).toLocaleString("en-IN"); }
function toast(m) { var e = $("toast"); e.textContent = m; e.classList.add("show"); setTimeout(function () { e.classList.remove("show"); }, 3600); }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function fmtWhen(t) { return new Date(t).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }
async function rpc(name, args) { var r = await sb.rpc(name, args || {}); if (r.error) throw new Error(r.error.message); return r.data; }
async function callFn(name, body) {
  var map = cfg.FUNCTIONS || {};
  var r = await sb.functions.invoke(map[name] || name, { body: Object.assign({ action: name }, body) });
  if (r.error) {
    var m = "Something went wrong";
    try { var j = await r.error.context.json(); m = j.error || m; } catch (e) { m = r.error.message || m; }
    throw new Error(m);
  }
  return r.data;
}
function fail(e) { toast((e && e.message) || "Something went wrong"); }

var SERVICES = [
  { k: "Shopping", e: "🛍️", c: "#FFE3B8", d: "Browse, pick outfits and enjoy a day at the mall or market.", v: ["Mall / Market", "Cafe / Restaurant"] },
  { k: "Movie", e: "🎬", c: "#D6E8FF", d: "Someone to watch a film with and chat about it afterwards.", v: ["Cinema hall", "Cafe / Restaurant"] },
  { k: "Club & Party", e: "🎉", c: "#F3D9FF", d: "A friendly plus-one at registered venues. No pressure to drink.", v: ["Registered club / lounge", "Banquet / Party venue"] },
  { k: "Wedding", e: "💒", c: "#FFD6DD", d: "A polite, well-dressed guest for weddings and receptions.", v: ["Wedding venue / Banquet"] },
  { k: "Study", e: "📚", c: "#D4F2E3", d: "A study buddy for focus, exam prep or language practice.", v: ["Library / Study cafe", "Cafe / Restaurant"] },
  { k: "Play", e: "🎮", c: "#FFF0B3", d: "Sports, board games, gaming or a walk. Fun without the awkwardness.", v: ["Sports ground / Park", "Gaming cafe / Arcade", "Board-game cafe"] },
  { k: "Caretaker", e: "🤝", c: "#DCE6F5", d: "Police-verified caretakers for elders and patients.", v: ["Home (verified caretakers only)", "Hospital / Clinic", "Park (walks)"] }
];
function svc(k) { return SERVICES.filter(function (s) { return s.k === k; })[0]; }
var STATES = ["Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal","Andaman and Nicobar Islands","Chandigarh","Dadra and Nagar Haveli and Daman and Diu","Delhi","Jammu and Kashmir","Ladakh","Lakshadweep","Puducherry"];
var AGES = [["", "Any age"], ["18-25", "18 to 25"], ["26-35", "26 to 35"], ["36-45", "36 to 45"], ["46-", "46 and above"]];
var AVC = ["#CFE3FF", "#FFD9E6", "#D8F2DD", "#FFE9B8", "#E7DAFB", "#CDEFF0"];
function avc(id) { var n = 0; for (var i = 0; i < id.length; i++) n += id.charCodeAt(i); return AVC[n % AVC.length]; }

/* ---------- state ---------- */
var S = {
  view: "boot", user: null, profile: null, comp: null,
  set: { commission_pct: 15, fee_pct: 5, min_withdrawal: 500 },
  form: {}, tab: "browse", cat: "All", list: [], bookings: [], reqs: [], bal: 0, ledger: [], wds: [],
  sel: null, bk: {}, codes: {}, mode: null, routing: false,
  filters: { state: "", city: "", gender: "", age: "" }, showF: false
};
try { S.mode = localStorage.getItem("yaari_mode"); } catch (e) {}

/* ---------- routing ---------- */
function go(v) { S.view = v; render(); window.scrollTo(0, 0); closeSheet(); }
async function loadMe() {
  var p = await sb.from("profiles").select("*").eq("id", S.user.id).maybeSingle();
  S.profile = p.data;
  var st = await sb.from("settings").select("*").eq("id", 1).maybeSingle();
  if (st.data) S.set = st.data;
  var c = await sb.from("companion_profiles").select("*").eq("user_id", S.user.id).maybeSingle();
  S.comp = c.data;
}
async function route() {
  if (S.routing) return; S.routing = true;
  try {
    if (!S.user) { S.profile = null; S.comp = null; return go(["home", "login", "signup", "reset", "checkmail"].indexOf(S.view) > -1 ? S.view : "home"); }
    await loadMe();
    var p = S.profile;
    if (!p) { await sb.auth.signOut(); return go("home"); }
    if (p.status === "incomplete" || p.status === "rejected") {
      if (cfg.REQUIRE_PHONE_OTP && !p.mobile_verified) return go("phone");
      S.form = { dob: p.dob || "", gender: p.gender || "", city: p.city || "", state: p.state || "", idType: p.id_type || "", ecName: p.emergency_name || "", ecPhone: p.emergency_mobile || "" };
      return go("kyc");
    }
    if (p.status === "pending") return go("wait");
    if (p.status === "suspended") return go("blocked");
    if (S.view === "newpw") return;
    if (!S.mode) return go("role");
    return enter(S.mode);
  } catch (e) { fail(e); } finally { S.routing = false; }
}
function enter(mode) {
  S.mode = mode; try { localStorage.setItem("yaari_mode", mode); } catch (e) {}
  if (mode === "earn") {
    if (!S.comp) { S.form = { svcs: [], days: [] }; return go("setup"); }
    S.tab = "requests"; go("companion"); loadCompanion();
  } else { S.tab = "browse"; go("renter"); loadList(); loadBookings(); }
}

/* ---------- data loaders ---------- */
async function loadList() {
  var q = sb.from("public_companions").select("*").order("rate");
  if (S.cat !== "All") q = q.contains("services", [S.cat]);
  var F = S.filters;
  if (F.state) q = q.eq("state", F.state);
  if (F.city && F.city.trim()) q = q.ilike("city", "%" + F.city.trim().replace(/[%_,()]/g, "") + "%");
  if (F.gender) q = q.eq("gender", F.gender);
  if (F.age) { var ag = F.age.split("-"); q = q.gte("age", +ag[0]); if (ag[1]) q = q.lte("age", +ag[1]); }
  var r = await q; if (r.error) return fail(r.error);
  S.list = r.data || []; if (S.view === "renter") render();
}
async function loadBookings() {
  var r = await sb.from("bookings").select("*").eq("renter_id", S.user.id).order("created_at", { ascending: false });
  if (r.error) return fail(r.error);
  S.bookings = r.data || [];
  var ids = S.bookings.filter(function (b) { return ["paid", "accepted"].indexOf(b.status) > -1; }).map(function (b) { return b.id; });
  if (ids.length) {
    var c = await sb.from("booking_codes").select("*").in("booking_id", ids);
    (c.data || []).forEach(function (x) { S.codes[x.booking_id] = x.code; });
  }
  if (S.view === "renter") render();
}
async function loadCompanion() {
  var a = await sb.from("bookings").select("*").eq("companion_id", S.user.id).order("created_at", { ascending: false });
  S.reqs = a.data || [];
  S.bal = await rpc("my_balance");
  var l = await sb.from("wallet_ledger").select("*").eq("user_id", S.user.id).order("created_at", { ascending: false }).limit(50);
  S.ledger = l.data || [];
  var w = await sb.from("withdrawals").select("*").eq("user_id", S.user.id).order("created_at", { ascending: false }).limit(20);
  S.wds = w.data || [];
  if (S.view === "companion") render();
}

/* ---------- render ---------- */
var VIEWS = {};
function render() {
  var inApp = S.view === "renter" || S.view === "companion";
  var right = "";
  if (inApp) right = '<div class="row"><button class="btn alt sm" data-a="switch">' + (S.view === "renter" ? "Switch to earning" : "Switch to renting") + '</button><button class="btn alt sm" data-a="logout">Log out</button></div>';
  else if (S.user) right = '<button class="btn alt sm" data-a="logout">Log out</button>';
  else if (S.view === "home") right = '<div class="row"><button class="btn alt sm" data-a="nav" data-v="login">Log in</button><button class="btn sm" data-a="nav" data-v="signup">Sign up</button></div>';
  else right = '<button class="btn alt sm" data-a="nav" data-v="home">Home</button>';
  $("top").innerHTML = '<div class="top"><div class="wrap"><button class="logo" data-a="nav" data-v="' + (S.user ? S.view : "home") + '" aria-label="Yaari">Yaari<span>.</span></button>' + right + '</div></div>';
  var fn = VIEWS[S.view]; $("app").innerHTML = fn ? fn() : "";
}

function inp(name, type, label, extra, hint) {
  return '<label class="lbl" for="f_' + name + '">' + label + '</label><input class="in" id="f_' + name + '" data-f="' + name + '" type="' + type + '" value="' + esc(S.form[name] || "") + '" ' + (extra || "") + '>' + (hint ? '<p class="hint">' + hint + '</p>' : "");
}
function chk(name, text) { return '<label class="chk"><input type="checkbox" data-f="' + name + '" ' + (S.form[name] ? "checked" : "") + '><span>' + text + '</span></label>'; }
function chips(key, arr, cur, fmt, act) { return '<div class="chips">' + arr.map(function (v) { return '<button class="chip" data-a="' + (act || "bk") + '" data-k="' + key + '" data-v="' + esc(v) + '" aria-pressed="' + (String(cur) === String(v)) + '">' + esc(fmt ? fmt(v) : v) + '</button>'; }).join("") + '</div>'; }
function pillFor(st) { return st === "completed" ? "pill g" : (st === "refunded" || st === "cancelled") ? "pill r" : "pill"; }
var STLBL = { pending_payment: "Awaiting payment", paid: "Waiting for companion", accepted: "Confirmed", in_progress: "In progress", completed: "Completed", refunded: "Refunded", cancelled: "Cancelled" };

VIEWS.boot = function () { return '<div class="narrow form"><p class="meta">Loading…</p></div>'; };

VIEWS.home = function () {
  var keep = Math.round(100 - S.set.commission_pct);
  return '<div class="hero"><div class="wrap"><h1>Good company for every plan.</h1><p>Book a verified, friendly companion for shopping, movies, parties, weddings, studying, games or caregiving. Platonic, public and safe by design.</p>' +
    '<div class="row wrapx"><button class="btn gold" data-a="nav" data-v="signup">Get started</button><button class="btn alt" data-a="nav" data-v="login">I already have an account</button></div></div></div><div class="wrap">' +
    '<section class="s"><h2>What can you book?</h2><p class="sub">Seven kinds of company, each with its own safety rules.</p><div class="grid">' +
    SERVICES.map(function (s) { return '<div class="tile" style="background:' + s.c + ';color:#0E1B33"><div class="em">' + s.e + '</div><h3>' + s.k + '</h3><p>' + s.d + '</p></div>'; }).join("") + '</div></section>' +
    '<section class="s"><h2>Safety comes first</h2><div class="safe">' +
    [["18+ only", "Date of birth is checked at sign-up and again on our server."], ["ID verification", "Every member is reviewed by our team before they can book or be booked."], ["Public venues only", "Malls, cafes, cinemas and registered venues. Home visits only for verified caretakers."], ["Strictly platonic", "No sexual services or physical intimacy. Violations mean a permanent ban."], ["SOS button", "One tap alerts Yaari support with your location."], ["Secure payments", "Pay only through Yaari. Money is released after the meeting is complete."]].map(function (x) { return '<div class="card"><b>' + x[0] + '</b><span class="meta">' + x[1] + '</span></div>'; }).join("") + '</div></section>' +
    '<section class="s"><div class="earn"><h2>Earn on your own schedule</h2><ul><li>Set your own hourly rate.</li><li>You keep ' + keep + '% of every booking.</li><li>Withdraw to UPI once your balance reaches ' + rs(S.set.min_withdrawal) + '.</li></ul><button class="btn gold" data-a="nav" data-v="signup">Become a companion</button></div></section>' +
    '<footer>Yaari is a marketplace for platonic companionship. Members are independent and are not employees of Yaari. In an emergency call 112.<br><a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a> · <a href="refund.html">Refunds</a> · <a href="contact.html">Contact</a></footer></div>';
};

VIEWS.signup = function () {
  return '<div class="narrow form"><h2>Create your account</h2>' + inp("name", "text", "Full name (as on your ID)", 'autocomplete="name"') + inp("email", "email", "Email address", 'autocomplete="email"') +
    '<label class="lbl" for="f_mobile">Mobile number</label><div class="pre"><div class="code">+91</div><input class="in" id="f_mobile" data-f="mobile" type="tel" inputmode="numeric" maxlength="10" value="' + esc(S.form.mobile || "") + '" autocomplete="tel-national"></div>' +
    inp("pw", "password", "Password", 'autocomplete="new-password"', "At least 8 characters with a letter and a number.") +
    chk("age18", "I am 18 years old or older.") + chk("agreeTerms", "I agree to the <a href='terms.html' target='_blank'>Terms</a> and <a href='privacy.html' target='_blank'>Privacy Policy</a>.") +
    '<div class="actions"><p class="err" id="err"></p><button class="btn full" data-a="signup">Create account</button></div>' +
    '<p class="hint" style="text-align:center">Already a member? <button class="link" data-a="nav" data-v="login">Log in</button></p></div>';
};
VIEWS.checkmail = function () {
  return '<div class="narrow form"><h2>Check your email</h2><p class="sub">We sent a confirmation link to <b>' + esc(S.form.email || "your email") + '</b>. Click it, then come back and log in.</p><button class="btn full" data-a="nav" data-v="login">Go to log in</button></div>';
};
VIEWS.login = function () {
  return '<div class="narrow form"><h2>Welcome back</h2>' + inp("lemail", "email", "Email", 'autocomplete="username"') + inp("lpw", "password", "Password", 'autocomplete="current-password"') +
    '<div class="actions"><p class="err" id="err"></p><button class="btn full" data-a="login">Log in</button></div>' +
    '<p class="hint" style="text-align:center"><button class="link" data-a="nav" data-v="reset">Forgot password?</button> · <button class="link" data-a="nav" data-v="signup">Create an account</button></p></div>';
};
VIEWS.reset = function () {
  return '<div class="narrow form"><h2>Reset password</h2>' + inp("remail", "email", "Your email") + '<div class="actions"><p class="err" id="err"></p><button class="btn full" data-a="reset">Send reset link</button></div></div>';
};
VIEWS.newpw = function () {
  return '<div class="narrow form"><h2>Choose a new password</h2>' + inp("npw", "password", "New password", 'autocomplete="new-password"', "At least 8 characters with a letter and a number.") + '<div class="actions"><p class="err" id="err"></p><button class="btn full" data-a="newpw">Save password</button></div></div>';
};
VIEWS.phone = function () {
  var sent = S.form.otpSent;
  return '<div class="narrow form"><h2>Verify your mobile</h2><p class="sub">We will text a 6-digit code to +91 ' + esc(S.profile.mobile || "") + '.</p>' +
    (sent ? inp("otp", "text", "Code", 'inputmode="numeric" maxlength="6"') + '<div class="actions"><p class="err" id="err"></p><button class="btn full" data-a="verifyphone">Verify</button></div>' :
      '<div class="actions"><p class="err" id="err"></p><button class="btn full" data-a="sendphone">Send code</button></div>') + '</div>';
};
VIEWS.kyc = function () {
  var max = new Date(); max.setFullYear(max.getFullYear() - 18);
  var p = S.profile;
  return '<div class="narrow form"><h2>Verify your identity</h2><p class="sub">Our team reviews every profile before it goes live. This keeps everyone safe.</p>' +
    (p.status === "rejected" ? '<div class="note"><b>Your last submission was not approved.</b> ' + esc(p.reject_reason || "Please check your details and upload a clear ID photo.") + '</div>' : "") +
    inp("dob", "date", "Date of birth", 'max="' + isoDate(max) + '" min="1940-01-01"', "You must be 18 or older.") +
    '<label class="lbl" for="f_gender">Gender</label><select class="in" id="f_gender" data-f="gender"><option value="">Select</option>' + ["Female", "Male", "Non-binary", "Prefer not to say"].map(function (o) { return '<option ' + (S.form.gender === o ? "selected" : "") + '>' + o + '</option>'; }).join("") + '</select>' +
    '<label class="lbl" for="f_state">State</label><select class="in" id="f_state" data-f="state"><option value="">Select</option>' + STATES.map(function (o) { return '<option ' + (S.form.state === o ? "selected" : "") + '>' + o + '</option>'; }).join("") + '</select>' +
    inp("city", "text", "City") +
    '<label class="lbl" for="f_idType">Government ID type</label><select class="in" id="f_idType" data-f="idType"><option value="">Select</option>' + ["Aadhaar (masked)", "PAN card", "Driving licence", "Passport", "Voter ID"].map(function (o) { return '<option ' + (S.form.idType === o ? "selected" : "") + '>' + o + '</option>'; }).join("") + '</select>' +
    '<label class="lbl" for="idFile">Upload ID photo</label><input class="in" id="idFile" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"><p class="hint">JPG, PNG or PDF up to 5 MB. Aadhaar: please mask the first 8 digits. Only our verification team can see it.</p>' +
    inp("ecName", "text", "Emergency contact name") +
    '<label class="lbl" for="f_ecPhone">Emergency contact mobile</label><div class="pre"><div class="code">+91</div><input class="in" id="f_ecPhone" data-f="ecPhone" type="tel" inputmode="numeric" maxlength="10" value="' + esc(S.form.ecPhone || "") + '"></div>' +
    '<div style="margin-top:14px">' + chk("r2", "I understand Yaari is <b>strictly platonic</b>. I will not offer, ask for or accept sexual services or physical intimacy.") +
    chk("r3", "I will meet only at <b>public or registered venues</b>. Home visits are only for verified caretakers.") +
    chk("r4", "I will not pressure anyone to drink alcohol or use drugs, and I will follow the law.") +
    chk("r5", "I will pay and get paid <b>only through Yaari</b>.") +
    chk("r6", "I agree to the Terms, the Privacy Policy and to ID and background verification.") + '</div>' +
    '<div class="actions"><p class="err" id="err"></p><button class="btn gold full" data-a="submitkyc">Submit for review</button></div></div>';
};
VIEWS.wait = function () {
  return '<div class="narrow form"><h2>Under review</h2><p class="sub">Thanks, ' + esc((S.profile.full_name || "").split(" ")[0]) + '. Our team is checking your details. This usually takes a short while. You will be able to use Yaari as soon as you are approved.</p><button class="btn full" data-a="recheck">Check status</button></div>';
};
VIEWS.blocked = function () {
  return '<div class="narrow form"><h2>Account on hold</h2><p class="sub">Your account is currently suspended. Please contact Yaari support.</p></div>';
};
VIEWS.role = function () {
  return '<div class="narrow form"><h2>Hi ' + esc((S.profile.full_name || "").split(" ")[0]) + ', what would you like to do?</h2><p class="sub">You can switch any time from the top bar.</p>' +
    '<button class="role" data-a="role" data-v="rent"><div style="font-size:30px">🔎</div><h3>I want to rent a companion</h3><p>Browse verified people for shopping, movies, parties, weddings, study, play or care.</p></button>' +
    '<button class="role" data-a="role" data-v="earn"><div style="font-size:30px">💰</div><h3>I want to rent myself out</h3><p>Set your own rate and earn. You keep ' + Math.round(100 - S.set.commission_pct) + '% of every booking.</p></button></div>';
};
VIEWS.setup = function () {
  var f = S.form; f.svcs = f.svcs || []; f.days = f.days || [];
  var care = f.svcs.indexOf("Caretaker") > -1;
  return '<div class="narrow form"><h2>' + (S.comp ? "Edit" : "Set up") + ' your companion profile</h2><p class="sub">This is what renters will see.</p>' +
    '<span class="lbl">Services you offer</span><div class="chips">' + SERVICES.map(function (s) { return '<button class="chip" data-a="tg" data-k="svcs" data-v="' + s.k + '" aria-pressed="' + (f.svcs.indexOf(s.k) > -1) + '">' + s.e + ' ' + s.k + '</button>'; }).join("") + '</div>' +
    inp("rate", "number", "Your rate per hour (₹)", 'min="100" max="5000" inputmode="numeric"', "Between ₹100 and ₹5,000. Yaari keeps " + S.set.commission_pct + "% commission.") +
    '<label class="lbl" for="f_bio">Short bio</label><textarea class="in" id="f_bio" data-f="bio" rows="4" maxlength="280" placeholder="Tell renters about yourself in a few friendly lines.">' + esc(f.bio || "") + '</textarea>' +
    '<span class="lbl">Available on</span><div class="chips">' + ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(function (d) { return '<button class="chip" data-a="tg" data-k="days" data-v="' + d + '" aria-pressed="' + (f.days.indexOf(d) > -1) + '">' + d + '</button>'; }).join("") + '</div>' +
    (care ? '<div class="note"><b>Caretaker listings need extra checks.</b> Upload your police verification certificate. Your Caretaker service stays hidden until our team approves it.</div><label class="lbl" for="pvFile">Police verification certificate</label><input class="in" id="pvFile" type="file" accept="image/jpeg,image/png,image/webp,application/pdf">' : "") +
    chk("c1", "I will follow Yaari's safety rules and meet only at allowed venues.") +
    '<div class="actions"><p class="err" id="err"></p><button class="btn gold full" data-a="savesetup">' + (S.comp ? "Save" : "Go live") + '</button></div></div>';
};

VIEWS.renter = function () {
  var h = '<div class="wrap main">';
  if (S.tab === "browse") {
    h += '<div class="chips" style="margin-bottom:12px">' + ["All"].concat(SERVICES.map(function (s) { return s.k; })).map(function (k) { return '<button class="chip" data-a="cat" data-v="' + k + '" aria-pressed="' + (S.cat === k) + '">' + k + '</button>'; }).join("") + '</div>';
    var F = S.filters, nAct = ["state", "city", "gender", "age"].filter(function (k) { return F[k]; }).length;
    h += '<div class="row" style="margin-bottom:10px"><button class="btn alt sm" data-a="togglef">Filters' + (nAct ? " (" + nAct + ")" : "") + (S.showF ? " ▲" : " ▼") + '</button>' + (nAct ? '<button class="btn alt sm" data-a="clearf">Clear filters</button>' : "") + '</div>';
    if (S.showF) {
      h += '<div class="card" style="margin-bottom:12px">' +
        '<label class="lbl" style="margin-top:0" for="fl_state">State</label><select class="in" id="fl_state" data-fl="state"><option value="">Any state</option>' + STATES.map(function (o) { return '<option ' + (F.state === o ? "selected" : "") + '>' + o + '</option>'; }).join("") + '</select>' +
        '<label class="lbl" for="fl_city">City</label><input class="in" id="fl_city" data-fl="city" placeholder="e.g. Kolkata" value="' + esc(F.city) + '">' +
        '<span class="lbl">Gender</span>' + chips("gender", ["", "Female", "Male", "Non-binary"], F.gender, function (v) { return v || "Any"; }, "fl") +
        '<label class="lbl" for="fl_age">Age</label><select class="in" id="fl_age" data-fl="age">' + AGES.map(function (a) { return '<option value="' + a[0] + '" ' + (F.age === a[0] ? "selected" : "") + '>' + a[1] + '</option>'; }).join("") + '</select>' +
        '<button class="btn full" style="margin-top:12px" data-a="applyf">Show results</button></div>';
    }
    h += S.list.length ? S.list.map(function (p) {
      return '<button class="pcard" data-a="openp" data-v="' + p.id + '"><div class="av" style="background:' + avc(p.id) + '" aria-hidden="true">' + esc((p.first_name || "?").charAt(0)) + '</div><div style="flex:1;min-width:0"><h3>' + esc(p.first_name) + ', ' + p.age + '<span class="badge' + (p.caretaker_verified ? " eh" : "") + '">' + (p.caretaker_verified ? "Enhanced" : "Verified") + ' ✓</span></h3><div class="meta">' + esc([p.city, p.state].filter(Boolean).join(", ")) + '</div><div style="margin-top:4px">' + (p.services || []).map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("") + '</div></div><div class="price">' + rs(p.rate) + '<small>per hour</small></div></button>';
    }).join("") : '<div class="card meta">No companions match these filters yet. Try clearing a filter. New people are approved every day.</div>';
  }
  if (S.tab === "bookings") {
    h += '<div class="row" style="justify-content:space-between;margin-bottom:10px"><h2>Your bookings</h2><button class="btn alt sm" data-a="refresh">Refresh</button></div>';
    if (!S.bookings.length) h += '<div class="card meta">No bookings yet. Find someone in Browse.</div>';
    h += S.bookings.map(function (b) {
      var acts = "";
      if (b.status === "pending_payment") acts = '<button class="btn sm" data-a="paynow" data-v="' + b.id + '">Pay ' + rs(b.total) + '</button><button class="btn alt sm" data-a="cancelunpaid" data-v="' + b.id + '">Cancel</button>';
      if (b.status === "paid") acts = '<button class="btn alt sm" data-a="refund" data-v="' + b.id + '">Cancel and refund</button>';
      if (b.status === "accepted") acts = '<button class="btn alt sm" data-a="refund" data-v="' + b.id + '">Cancel and refund</button><button class="sos" data-a="sos" data-v="' + b.id + '">SOS</button>';
      if (b.status === "in_progress") acts = '<button class="btn sm" data-a="complete" data-v="' + b.id + '">Meeting done: release payment</button><button class="sos" data-a="sos" data-v="' + b.id + '">SOS</button>';
      return '<div class="card" style="margin-bottom:10px"><div class="line" style="border:0;padding:0"><b>' + esc(b.service) + ' with ' + esc(b.companion_name) + '</b><span class="' + pillFor(b.status) + '">' + STLBL[b.status] + '</span></div>' +
        '<div class="meta">' + fmtWhen(b.starts_at) + ' · ' + b.hours + ' hr · ' + esc(b.venue_type) + ' (' + esc(b.venue_name) + ')</div><div class="meta">Total ' + rs(b.total) + '</div>' +
        (b.status === "accepted" && S.codes[b.id] ? '<div class="note">Check-in code: <b>' + esc(S.codes[b.id]) + '</b>. Tell it to ' + esc(b.companion_name) + ' only when you meet.</div>' : "") +
        (acts ? '<div class="row wrapx" style="margin-top:10px">' + acts + '</div>' : "") + '</div>';
    }).join("");
  }
  if (S.tab === "safety") {
    h += '<h2 style="margin-bottom:10px">Stay safe</h2><div class="safe">' + [["Before you meet", "Read the profile. Tell a friend where you are going."], ["At the venue", "Meet in a public place. Keep your own transport. Never share your check-in code before you meet."], ["Feeling uneasy?", "You can leave at any time. Tap SOS on the booking."], ["Emergency numbers", "Police and emergency: 112. Women helpline: 1091."]].map(function (x) { return '<div class="card"><b>' + x[0] + '</b><span class="meta">' + x[1] + '</span></div>'; }).join("") + '</div>';
  }
  return h + '</div>' + tabs([["browse", "Browse"], ["bookings", "Bookings"], ["safety", "Safety"]]);
};
function tabs(t) { return '<nav class="tabs" aria-label="Main">' + t.map(function (x) { return '<button data-a="tab" data-v="' + x[0] + '" ' + (S.tab === x[0] ? 'aria-current="true"' : "") + '>' + x[1] + '</button>'; }).join("") + '</nav>'; }

VIEWS.companion = function () {
  var c = S.comp || {}, h = '<div class="wrap main">';
  if (S.tab === "requests") {
    h += '<div class="row" style="justify-content:space-between;margin-bottom:10px"><h2>Booking requests</h2><button class="btn alt sm" data-a="refresh">Refresh</button></div>';
    if (!S.reqs.length) h += '<div class="card meta">No requests yet. Make sure your profile is complete.</div>';
    h += S.reqs.map(function (r) {
      var acts = "";
      if (r.status === "paid") acts = '<button class="btn sm" data-a="accept" data-v="' + r.id + '">Accept</button><button class="btn alt sm" data-a="refund" data-v="' + r.id + '">Decline</button>';
      if (r.status === "accepted") acts = '<input class="in" style="width:110px;margin:0" id="code_' + r.id + '" inputmode="numeric" maxlength="4" placeholder="4-digit code"><button class="btn sm" data-a="start" data-v="' + r.id + '">Start meeting</button><button class="sos" data-a="sos" data-v="' + r.id + '">SOS</button>';
      if (r.status === "in_progress") acts = '<span class="meta">Meeting in progress. You are paid when the renter confirms.</span><button class="sos" data-a="sos" data-v="' + r.id + '">SOS</button>';
      return '<div class="card" style="margin-bottom:10px"><div class="line" style="border:0;padding:0"><b>' + esc(r.service) + ' with ' + esc(r.renter_name) + '</b><span class="' + pillFor(r.status) + '">' + STLBL[r.status] + '</span></div>' +
        '<div class="meta">' + fmtWhen(r.starts_at) + ' · ' + r.hours + ' hr · ' + esc(r.venue_type) + ' (' + esc(r.venue_name) + ')</div><div class="meta">You earn <b>' + rs(r.net) + '</b> after ' + S.set.commission_pct + '% commission</div>' +
        (r.status === "accepted" ? '<div class="note">Ask ' + esc(r.renter_name) + ' for their 4-digit check-in code when you meet.</div>' : "") +
        (acts ? '<div class="row wrapx" style="margin-top:10px">' + acts + '</div>' : "") + '</div>';
    }).join("");
  }
  if (S.tab === "earnings") {
    var can = S.bal >= S.set.min_withdrawal;
    h += '<div class="bal"><span>Available balance</span><b>' + rs(S.bal) + '</b><button class="btn gold" style="margin-top:10px" data-a="wd" ' + (can ? "" : "disabled") + '>Withdraw</button><div style="margin-top:8px;font-size:14px;opacity:.9">' + (can ? "Ready to withdraw to your UPI." : "Minimum withdrawal is " + rs(S.set.min_withdrawal) + ". You need " + rs(S.set.min_withdrawal - S.bal) + " more.") + '</div></div>' +
      '<h3 style="margin:14px 0 4px">History</h3>' + (S.ledger.length ? S.ledger.map(function (x) { return '<div class="line"><span>' + esc(x.note || x.type) + '<br><span class="meta">' + fmtWhen(x.created_at) + '</span></span><b style="color:' + (x.amount < 0 ? "var(--warn)" : "var(--teal)") + '">' + (x.amount < 0 ? "−" : "+") + rs(Math.abs(x.amount)) + '</b></div>'; }).join("") : '<div class="card meta">No earnings yet.</div>') +
      (S.wds.length ? '<h3 style="margin:16px 0 4px">Withdrawals</h3>' + S.wds.map(function (w) { return '<div class="line"><span>' + rs(w.amount) + ' to ' + esc(w.upi) + '</span><span class="pill ' + (w.status === "paid" ? "g" : w.status === "rejected" ? "r" : "") + '">' + w.status + '</span></div>'; }).join("") : "");
  }
  if (S.tab === "profile") {
    h += '<h2 style="margin-bottom:10px">Your profile</h2><div class="card"><b>' + esc(S.profile.full_name) + '</b><div class="meta">' + esc(S.profile.city || "") + '</div><p>' + esc(c.bio || "") + '</p>' + (c.services || []).map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("") +
      '<div class="line" style="margin-top:10px"><span>Hourly rate</span><b>' + rs(c.rate || 0) + '</b></div><div class="line"><span>Available</span><b>' + esc((c.days || []).join(", ")) + '</b></div>' +
      ((c.services || []).indexOf("Caretaker") > -1 ? '<div class="line"><span>Caretaker approval</span><span class="pill ' + (c.caretaker_verified ? "g" : "o") + '">' + (c.caretaker_verified ? "Approved" : "Pending") + '</span></div>' : "") + '</div>' +
      '<button class="btn alt full" style="margin-top:12px" data-a="editprofile">Edit profile</button>';
  }
  return h + '</div>' + tabs([["requests", "Requests"], ["earnings", "Earnings"], ["profile", "Profile"]]);
};

/* ---------- sheets ---------- */
function openSheet() { $("sheet").classList.add("open"); $("scrim").classList.add("open"); }
function closeSheet() { $("sheet").classList.remove("open"); $("scrim").classList.remove("open"); }
function person(id) { return S.list.filter(function (p) { return p.id === id; })[0]; }
function calc() { var p = person(S.sel), g = p.rate * S.bk.hrs, f = Math.round(g * S.set.fee_pct / 100); return { g: g, f: f, t: g + f }; }
function sheetProfile() {
  var p = person(S.sel); $("shT").textContent = p.first_name + ", " + p.age;
  $("shB").innerHTML = '<div class="av" style="background:' + avc(p.id) + ';width:84px;height:84px;font-size:40px;margin:4px 0 8px">' + esc(p.first_name.charAt(0)) + '</div><div class="meta">' + esc([p.city, p.state].filter(Boolean).join(", ")) + ' · ' + esc(p.gender || "") + ' <span class="badge' + (p.caretaker_verified ? " eh" : "") + '">' + (p.caretaker_verified ? "Enhanced" : "Verified") + ' ✓</span></div><p>' + esc(p.bio || "") + '</p>' + (p.services || []).map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("") +
    '<div class="note">Meetings happen only at public or registered venues. Strictly platonic.</div>';
  $("shF").innerHTML = '<button class="cta btn full" data-a="bookgo">Book from ' + rs(p.rate) + ' per hour</button>';
}
function sheetBook() {
  var p = person(S.sel), b = S.bk; $("shT").textContent = "Plan with " + p.first_name;
  var venues = svc(b.svc).v; if (venues.indexOf(b.venueType) < 0) b.venueType = venues[0];
  var c = calc(), min = new Date(Date.now() + 90 * 60000); min.setMinutes(min.getMinutes() - min.getTimezoneOffset());
  $("shB").innerHTML = '<span class="lbl">What for?</span>' + chips("svc", p.services, b.svc) + '<span class="lbl">How long?</span>' + chips("hrs", [1, 2, 3, 4], b.hrs, function (v) { return v + " hr"; }) +
    '<label class="lbl" for="bwhen">Date and start time</label><input class="in" id="bwhen" type="datetime-local" data-b="when" min="' + min.toISOString().slice(0, 16) + '" value="' + esc(b.when || "") + '">' +
    '<span class="lbl">Venue type <span class="meta">(public places only)</span></span>' + chips("venueType", venues, b.venueType) +
    '<label class="lbl" for="bvenue">Venue name</label><input class="in" id="bvenue" data-b="venue" placeholder="e.g. South City Mall" value="' + esc(b.venue || "") + '">' +
    '<div class="sum"><div class="r"><span>' + rs(p.rate) + ' × ' + b.hrs + ' hr</span><span>' + rs(c.g) + '</span></div><div class="r"><span>Safety and service fee (' + S.set.fee_pct + '%)</span><span>' + rs(c.f) + '</span></div><div class="r t"><span>Total</span><span>' + rs(c.t) + '</span></div></div><p class="err" id="err"></p>';
  $("shF").innerHTML = '<button class="btn full" data-a="paygo">Pay and send request</button>';
}
function sheetWd() {
  $("shT").textContent = "Withdraw earnings";
  $("shB").innerHTML = '<div class="sum" style="margin-top:4px"><div class="r t"><span>Amount</span><span>' + rs(S.bal) + '</span></div></div><label class="lbl" for="upi">UPI ID</label><input class="in" id="upi" placeholder="name@bank" autocomplete="off"><p class="hint">Yaari sends the money to this UPI ID after a quick check, usually within 1 to 2 working days.</p><p class="err" id="err"></p>';
  $("shF").innerHTML = '<button class="btn full" data-a="wdgo">Request withdrawal</button>';
}
function err(m) { var e = $("err"); if (e) e.textContent = m; }

/* ---------- actions ---------- */
var A = {};
A.nav = function (v) { go(v); };
A.closesheet = closeSheet;
A.signup = async function () {
  var f = S.form;
  if (!f.name || f.name.trim().length < 3) return err("Please enter your full name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email || "")) return err("Enter a valid email address.");
  if (!/^[6-9]\d{9}$/.test(f.mobile || "")) return err("Enter a valid 10-digit Indian mobile number.");
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(f.pw || "")) return err("Password needs 8+ characters with a letter and a number.");
  if (!f.age18) return err("You must confirm that you are 18 or older.");
  if (!f.agreeTerms) return err("Please accept the Terms and Privacy Policy.");
  var r = await sb.auth.signUp({ email: f.email.trim().toLowerCase(), password: f.pw, options: { data: { full_name: f.name.trim(), mobile: f.mobile }, emailRedirectTo: location.origin + location.pathname } });
  if (r.error) return err(r.error.message);
  S.form = { email: f.email }; if (r.data.session) { S.user = r.data.user; route(); } else go("checkmail");
};
A.login = async function () {
  var f = S.form;
  if (!f.lemail || !f.lpw) return err("Enter your email and password.");
  var r = await sb.auth.signInWithPassword({ email: f.lemail.trim().toLowerCase(), password: f.lpw });
  if (r.error) return err(r.error.message);
  S.user = r.data.user; S.form = {}; await route();
};
A.reset = async function () {
  var e = (S.form.remail || "").trim(); if (!e) return err("Enter your email.");
  var r = await sb.auth.resetPasswordForEmail(e, { redirectTo: location.origin + location.pathname });
  if (r.error) return err(r.error.message); toast("If that email exists, a reset link is on its way."); go("login");
};
A.newpw = async function () {
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(S.form.npw || "")) return err("Password needs 8+ characters with a letter and a number.");
  var r = await sb.auth.updateUser({ password: S.form.npw }); if (r.error) return err(r.error.message);
  toast("Password updated."); S.form = {}; S.view = "boot"; route();
};
A.logout = async function () { await sb.auth.signOut(); S.user = null; S.profile = null; S.comp = null; S.form = {}; go("home"); };
A.recheck = async function () { await route(); if (S.view === "wait") toast("Still under review."); };
A.sendphone = async function () {
  var r = await sb.auth.updateUser({ phone: "+91" + S.profile.mobile }); if (r.error) return err(r.error.message);
  S.form.otpSent = true; render();
};
A.verifyphone = async function () {
  var r = await sb.auth.verifyOtp({ phone: "+91" + S.profile.mobile, token: (S.form.otp || "").trim(), type: "phone_change" });
  if (r.error) return err(r.error.message); S.form = {}; await route();
};
A.submitkyc = async function () {
  var f = S.form;
  if (!f.dob) return err("Enter your date of birth.");
  var a = (Date.now() - new Date(f.dob).getTime()) / 31557600000; if (a < 18) return err("You must be 18 or older to use Yaari."); if (a > 90) return err("Please check your date of birth.");
  if (!f.gender) return err("Select a gender option."); if (!f.state) return err("Select your state."); if (!f.city || f.city.trim().length < 2) return err("Enter your city."); if (!f.idType) return err("Select your ID type.");
  var file = $("idFile").files[0], path = S.profile.id_path;
  if (cfg.REQUIRE_ID_UPLOAD && !file && !path) return err("Upload a photo of your ID.");
  if (!/^[6-9]\d{9}$/.test(f.ecPhone || "") || !f.ecName || f.ecName.trim().length < 2) return err("Add your emergency contact's name and 10-digit mobile.");
  if (f.ecPhone === S.profile.mobile) return err("Emergency contact must be someone else.");
  if (!(f.r2 && f.r3 && f.r4 && f.r5 && f.r6)) return err("Please accept all the safety rules.");
  if (file) {
    if (file.size > 5 * 1024 * 1024) return err("ID file must be under 5 MB.");
    var ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
    path = S.user.id + "/id-" + Date.now() + "." + ext;
    var up = await sb.storage.from("kyc").upload(path, file, { upsert: false, contentType: file.type }); if (up.error) return err(up.error.message);
  }
  var u = await sb.from("profiles").update({ dob: f.dob, gender: f.gender, city: f.city.trim(), state: f.state, id_type: f.idType, id_path: path, emergency_name: f.ecName.trim(), emergency_mobile: f.ecPhone, rules_accepted_at: new Date().toISOString(), status: "pending" }).eq("id", S.user.id);
  if (u.error) return err(u.error.message);
  S.form = {}; await route();
};
A.role = function (v) { enter(v === "rent" ? "rent" : "earn"); };
A.switch = function () { enter(S.view === "renter" ? "earn" : "rent"); };
A.tg = function (v, el) { var k = el.dataset.k, a = S.form[k] = S.form[k] || [], i = a.indexOf(v); if (i > -1) a.splice(i, 1); else a.push(v); render(); };
A.savesetup = async function () {
  var f = S.form, r = parseInt(f.rate, 10);
  if (!f.svcs || !f.svcs.length) return err("Choose at least one service.");
  if (!(r >= 100 && r <= 5000)) return err("Set a rate between ₹100 and ₹5,000 per hour.");
  if (!f.bio || f.bio.trim().length < 30) return err("Write a short bio of at least 30 characters.");
  if (!f.days || !f.days.length) return err("Choose the days you are available.");
  if (!f.c1) return err("Please accept the safety rule.");
  var care = f.svcs.indexOf("Caretaker") > -1, pv = $("pvFile") && $("pvFile").files[0], pvPath = S.comp && S.comp.police_cert_path;
  if (care && !pv && !pvPath) return err("Upload your police verification certificate for caretaker services.");
  if (pv) {
    if (pv.size > 5 * 1024 * 1024) return err("File must be under 5 MB.");
    pvPath = S.user.id + "/police-" + Date.now() + "." + ((pv.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, ""));
    var up = await sb.storage.from("kyc").upload(pvPath, pv, { contentType: pv.type }); if (up.error) return err(up.error.message);
  }
  var row = { user_id: S.user.id, services: f.svcs, rate: r, bio: f.bio.trim(), days: f.days, police_cert_path: pvPath || null };
  var w = await sb.from("companion_profiles").upsert(row, { onConflict: "user_id" }); if (w.error) return err(w.error.message);
  await loadMe(); S.form = {}; toast("Profile saved."); enter("earn");
};
A.editprofile = function () { var c = S.comp; S.form = { svcs: c.services.slice(), days: c.days.slice(), rate: c.rate, bio: c.bio, c1: true }; go("setup"); };
A.tab = function (v) { S.tab = v; render(); window.scrollTo(0, 0); if (S.view === "renter") { if (v === "bookings") loadBookings(); if (v === "browse") loadList(); } else { loadCompanion(); } };
A.refresh = function () { if (S.view === "renter") loadBookings(); else loadCompanion(); };
A.cat = function (v) { S.cat = v; render(); loadList(); };
A.togglef = function () { S.showF = !S.showF; render(); };
A.fl = function (v, el) { S.filters[el.dataset.k] = v; render(); };
A.applyf = function () { S.showF = false; render(); loadList(); };
A.clearf = function () { S.filters = { state: "", city: "", gender: "", age: "" }; S.showF = false; render(); loadList(); };
A.openp = function (v) { S.sel = v; var p = person(v); S.bk = { svc: p.services[0], hrs: 2, when: "", venueType: "", venue: "" }; sheetProfile(); openSheet(); };
A.bookgo = function () { sheetBook(); };
A.bk = function (v, el) { var k = el.dataset.k; S.bk[k] = (k === "hrs") ? +v : v; if (k === "svc") S.bk.venueType = ""; var t = $("shB").scrollTop; sheetBook(); $("shB").scrollTop = t; };
A.paygo = async function () {
  var b = S.bk;
  if (!b.when) return err("Choose a date and start time.");
  if (!b.venue || b.venue.trim().length < 3) return err("Enter the venue name. We only allow public or registered venues.");
  var id = await rpc("create_booking", { p_companion: S.sel, p_service: b.svc, p_hours: b.hrs, p_start: new Date(b.when).toISOString(), p_venue_type: b.venueType, p_venue_name: b.venue.trim() });
  closeSheet(); S.tab = "bookings"; render(); await loadBookings(); return pay(id);
};
A.paynow = function (v) { return pay(v); };
async function pay(bookingId) {
  if (!window.Razorpay) throw new Error("Razorpay could not load. Check your internet or turn off ad-blocker, then try again.");
  toast("Starting payment…");
  var d = await callFn("create-order", { booking_id: bookingId });
  var rz = new window.Razorpay({
    key: d.key_id, amount: d.amount, currency: "INR", order_id: d.order_id, name: "Yaari", description: "Companion booking",
    prefill: { name: S.profile.full_name, email: S.profile.email, contact: S.profile.mobile },
    theme: { color: "#0E1B33" },
    handler: async function (resp) {
      try { await callFn("verify-payment", resp); toast("Payment received. Waiting for your companion to accept."); }
      catch (e) { toast("Payment received. We are confirming it. Refresh in a minute."); }
      loadBookings();
    },
    modal: { ondismiss: function () { toast("Payment not completed. You can pay later from Bookings."); } }
  });
  rz.on("payment.failed", function () { toast("Payment failed. Please try again."); });
  rz.open();
}
A.cancelunpaid = async function (v) { await rpc("cancel_unpaid", { p_id: v }); loadBookings(); };
A.refund = async function (v) {
  if (!window.confirm("Cancel this booking and refund the payment?")) return;
  await callFn("refund-booking", { booking_id: v }); toast("Refund started. It reaches your account in a few working days.");
  if (S.view === "renter") loadBookings(); else loadCompanion();
};
A.accept = async function (v) { await rpc("accept_booking", { p_id: v }); toast("Accepted."); loadCompanion(); };
A.start = async function (v) { var c = ($("code_" + v) || {}).value || ""; await rpc("start_booking", { p_id: v, p_code: c }); toast("Meeting started."); loadCompanion(); };
A.complete = async function (v) { if (!window.confirm("Confirm the meeting is done and release the payment?")) return; await rpc("complete_booking", { p_id: v }); toast("Payment released. Thank you!"); loadBookings(); };
A.sos = async function (v) {
  var pos = await new Promise(function (res) { if (!navigator.geolocation) return res(null); navigator.geolocation.getCurrentPosition(function (p) { res(p.coords); }, function () { res(null); }, { timeout: 8000 }); });
  var r = await sb.from("alerts").insert({ user_id: S.user.id, booking_id: v || null, type: "SOS", note: "SOS pressed", lat: pos ? pos.latitude : null, lng: pos ? pos.longitude : null });
  if (r.error) throw r.error; toast("SOS sent to Yaari support. If you are in danger, call 112 now.");
};
A.wd = function () { if (S.bal < S.set.min_withdrawal) return; sheetWd(); openSheet(); };
A.wdgo = async function () {
  var u = ($("upi").value || "").trim();
  if (!/^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}$/.test(u)) return err("Enter a valid UPI ID, like name@bank.");
  await rpc("request_withdrawal", { p_amount: S.bal, p_upi: u }); closeSheet(); toast("Withdrawal requested."); loadCompanion();
};

/* ---------- events ---------- */
document.addEventListener("click", function (e) {
  var el = e.target.closest("[data-a]"); if (!el || (el.tagName === "BUTTON" && el.disabled)) return;
  var fn = A[el.dataset.a]; if (!fn) return;
  el.disabled = el.tagName === "BUTTON" ? true : el.disabled;
  Promise.resolve().then(function () { return fn(el.dataset.v, el); }).catch(fail).then(function () { if (el.isConnected) el.disabled = false; });
});
document.addEventListener("input", function (e) {
  var t = e.target;
  if (t.dataset.fl) S.filters[t.dataset.fl] = t.value;
  if (t.dataset.f) S.form[t.dataset.f] = t.type === "checkbox" ? t.checked : t.value;
  if (t.dataset.b) { S.bk[t.dataset.b] = t.value; }
});
document.addEventListener("change", function (e) { var t = e.target; if (t.dataset.fl) S.filters[t.dataset.fl] = t.value; if (t.dataset.f && t.type === "checkbox") S.form[t.dataset.f] = t.checked; });
$("scrim").onclick = closeSheet;
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeSheet(); });

/* ---------- start ---------- */
sb.auth.onAuthStateChange(function (ev, sess) {
  if (ev === "PASSWORD_RECOVERY") { S.user = sess.user; S.view = "newpw"; render(); return; }
  var u = sess ? sess.user : null;
  if ((u && u.id) !== (S.user && S.user.id)) { S.user = u; setTimeout(route, 0); }
});
sb.auth.getSession().then(function (r) { S.user = r.data.session ? r.data.session.user : null; if (S.view !== "newpw") route(); });
render();
})();
