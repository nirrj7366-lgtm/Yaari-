(function () {
"use strict";
var cfg = window.YAARI_CONFIG;
var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
var $ = function (i) { return document.getElementById(i); };
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function rs(n) { return "₹" + Math.round(n || 0).toLocaleString("en-IN"); }
function when(t) { return t ? new Date(t).toLocaleString("en-IN", { day: "numeric", month: "short", year: "2-digit", hour: "numeric", minute: "2-digit" }) : "-"; }
function toast(m) { var e = $("toast"); e.textContent = m; e.classList.add("show"); setTimeout(function () { e.classList.remove("show"); }, 3200); }
function fail(e) { toast((e && e.message) || "Something went wrong"); }

var D = { me: null, profiles: [], comps: [], bookings: [], payments: [], ledger: [], wds: [], alerts: [], audit: [], set: { commission_pct: 15, fee_pct: 5, min_withdrawal: 500 } };
var S = { tab: "overview", uf: "All", q: "", bf: "All" };
var TABS = [["overview", "Overview"], ["users", "Users"], ["bookings", "Bookings"], ["payments", "Payments and payouts"], ["safety", "Safety"], ["settings", "Settings"]];
var byId = function (id) { return D.profiles.filter(function (p) { return p.id === id; })[0] || { full_name: "Unknown" }; };
function pc(s) { return ["verified", "completed", "paid", "resolved", "captured"].indexOf(s) > -1 ? "g" : ["pending", "paid_wait", "open", "accepted", "in_progress"].indexOf(s) > -1 ? "o" : ["rejected", "suspended", "refunded", "cancelled"].indexOf(s) > -1 ? "r" : ""; }
async function audit(action, target) { await sb.from("audit_log").insert({ admin_id: D.me.id, action: action, target: String(target || "") }); }

/* ---------- sign in ---------- */
async function signIn() {
  $("lerr").textContent = "";
  var email = $("em").value.trim().toLowerCase(), pw = $("pw").value;
  if (!email || !pw) { $("lerr").textContent = "Enter your email and password."; return; }
  var r = await sb.auth.signInWithPassword({ email: email, password: pw });
  if (r.error) { $("lerr").textContent = r.error.message; return; }
  // 2-step verification (if you have set it up in Settings)
  var f = await sb.auth.mfa.listFactors();
  var tot = f.data && f.data.totp && f.data.totp.filter(function (x) { return x.status === "verified"; })[0];
  if (tot) {
    var code = $("mfa").value.trim();
    if (!code) { $("mfaBox").classList.remove("hide"); $("lerr").textContent = "Enter the 6-digit code from your authenticator app."; return; }
    var ch = await sb.auth.mfa.challenge({ factorId: tot.id });
    if (ch.error) { $("lerr").textContent = ch.error.message; return; }
    var vr = await sb.auth.mfa.verify({ factorId: tot.id, challengeId: ch.data.id, code: code });
    if (vr.error) { $("lerr").textContent = "Wrong code."; return; }
  }
  await enter();
}
async function enter() {
  var u = (await sb.auth.getUser()).data.user;
  if (!u) return;
  var a = await sb.from("admins").select("user_id").eq("user_id", u.id).maybeSingle();
  if (!a.data) { await sb.auth.signOut(); $("lerr").textContent = "This account is not an admin."; return; }
  D.me = u; $("who").textContent = u.email; $("login").classList.add("hide"); $("panel").classList.remove("hide");
  await loadAll(); render();
}
async function loadAll() {
  var q = function (t, o) { var x = sb.from(t).select("*"); return o ? o(x) : x; };
  var res = await Promise.all([
    q("profiles", function (x) { return x.order("created_at", { ascending: false }).limit(1000); }),
    q("companion_profiles"),
    q("bookings", function (x) { return x.order("created_at", { ascending: false }).limit(1000); }),
    q("payments", function (x) { return x.order("created_at", { ascending: false }).limit(1000); }),
    q("wallet_ledger", function (x) { return x.limit(5000); }),
    q("withdrawals", function (x) { return x.order("created_at", { ascending: false }).limit(500); }),
    q("alerts", function (x) { return x.order("created_at", { ascending: false }).limit(200); }),
    q("audit_log", function (x) { return x.order("created_at", { ascending: false }).limit(25); }),
    sb.from("settings").select("*").eq("id", 1).maybeSingle()
  ]);
  var keys = ["profiles", "comps", "bookings", "payments", "ledger", "wds", "alerts", "audit"];
  keys.forEach(function (k, i) { if (res[i].error) toast(k + ": " + res[i].error.message); D[k] = res[i].data || []; });
  if (res[8].data) D.set = res[8].data;
}

/* ---------- views ---------- */
var V = {};
function render() {
  $("tabs").innerHTML = TABS.map(function (t) { return '<button class="tab" data-a="tab" data-v="' + t[0] + '" ' + (S.tab === t[0] ? 'aria-current="true"' : "") + '>' + t[1] + '</button>'; }).join("");
  $("main").innerHTML = '<div class="acts" style="margin:0 0 10px"><button class="btn alt" data-a="reload">Refresh data</button><button class="btn alt" data-a="signout">Sign out</button></div>' + V[S.tab]();
}
function sums() {
  var s = { collected: 0, refunded: 0, platform: 0, escrow: 0, owed: 0 };
  D.payments.forEach(function (p) { if (p.status === "captured") s.collected += p.amount; if (p.status === "refunded") s.refunded += p.amount; });
  D.bookings.forEach(function (b) { if (b.status === "completed") s.platform += b.fee + b.commission; if (["paid", "accepted", "in_progress"].indexOf(b.status) > -1) s.escrow += b.total; });
  D.ledger.forEach(function (l) { s.owed += l.amount; });
  return s;
}
V.overview = function () {
  var st = {}; D.profiles.forEach(function (p) { st[p.status] = (st[p.status] || 0) + 1; });
  var compIds = {}; D.comps.forEach(function (c) { compIds[c.user_id] = 1; });
  var s = sums(), open = D.alerts.filter(function (a) { return a.status === "open"; }).length, pw = D.wds.filter(function (w) { return w.status === "pending"; });
  var k = function (a, b, c) { return '<div class="kpi"><span>' + a + '</span><b>' + b + '</b><small>' + (c || "") + '</small></div>'; };
  return '<h2 class="t">Overview</h2><div class="kpis">' +
    k("Registered users", D.profiles.length, (D.profiles.length - Object.keys(compIds).length) + " renters · " + Object.keys(compIds).length + " companions") +
    k("Awaiting review", st.pending || 0, "Open the Users tab") +
    k("Verified", st.verified || 0, (st.rejected || 0) + " rejected · " + (st.suspended || 0) + " suspended") +
    k("Total bookings", D.bookings.length, D.bookings.filter(function (b) { return ["paid", "accepted", "in_progress"].indexOf(b.status) > -1; }).length + " active") +
    k("Collected", rs(s.collected), rs(s.refunded) + " refunded") +
    k("Your earnings", rs(s.platform), "from completed bookings") +
    k("Held in escrow", rs(s.escrow), "until meetings finish") +
    k("Payouts pending", rs(pw.reduce(function (a, w) { return a + w.amount; }, 0)), pw.length + " requests") +
    k("Owed to companions", rs(s.owed), "wallet balances") +
    k("Open safety alerts", open, "Check Safety") + '</div>';
};
V.users = function () {
  var f = ["All", "pending", "verified", "rejected", "suspended"], q = S.q.toLowerCase();
  var compIds = {}; D.comps.forEach(function (c) { compIds[c.user_id] = 1; });
  var l = D.profiles.filter(function (u) { return (S.uf === "All" || u.status === S.uf) && (!q || (u.full_name + u.email + u.mobile + u.id).toLowerCase().indexOf(q) > -1); });
  return '<h2 class="t">Users (' + l.length + ')</h2><input class="in" id="q" placeholder="Search name, email, mobile or ID" value="' + esc(S.q) + '" aria-label="Search users">' +
    '<div class="chips">' + f.map(function (x) { return '<button class="chip" data-a="uf" data-v="' + x + '" aria-pressed="' + (S.uf === x) + '">' + x + '</button>'; }).join("") + '</div>' +
    (l.map(function (u) { return '<button class="card" style="display:block;width:100%;text-align:left" data-a="user" data-v="' + u.id + '"><div class="line"><b>' + esc(u.full_name) + '</b><span class="pill ' + pc(u.status) + '">' + u.status + '</span></div><div class="meta">' + (compIds[u.id] ? "Companion" : "Member") + ' · ' + esc(u.city || "-") + ' · joined ' + when(u.created_at) + '</div></button>'; }).join("") || '<div class="card meta">No users match.</div>');
};
V.bookings = function () {
  var f = ["All", "pending_payment", "paid", "accepted", "in_progress", "completed", "refunded", "cancelled"];
  var l = D.bookings.filter(function (b) { return S.bf === "All" || b.status === S.bf; });
  return '<h2 class="t">Bookings (' + l.length + ')</h2><div class="chips">' + f.map(function (x) { return '<button class="chip" data-a="bf" data-v="' + x + '" aria-pressed="' + (S.bf === x) + '">' + x.replace("_", " ") + '</button>'; }).join("") + '</div>' +
    (l.map(function (b) { return '<button class="card" style="display:block;width:100%;text-align:left" data-a="bk" data-v="' + b.id + '"><div class="line"><b>' + esc(b.service) + '</b><span class="pill ' + pc(b.status) + '">' + b.status.replace("_", " ") + '</span></div><div class="meta">' + esc(b.renter_name) + ' booked ' + esc(b.companion_name) + ' · ' + when(b.starts_at) + '</div><div class="meta">' + b.hours + ' hr · paid ' + rs(b.total) + ' · you earn ' + rs(b.fee + b.commission) + '</div></button>'; }).join("") || '<div class="card meta">No bookings.</div>');
};
V.payments = function () {
  var s = sums();
  return '<h2 class="t">Payments and payouts</h2><div class="kpis" style="margin-bottom:14px"><div class="kpi"><span>Collected</span><b>' + rs(s.collected) + '</b></div><div class="kpi"><span>Refunded</span><b>' + rs(s.refunded) + '</b></div><div class="kpi"><span>Owed to companions</span><b>' + rs(s.owed) + '</b></div><div class="kpi"><span>Your earnings</span><b>' + rs(s.platform) + '</b></div></div>' +
    '<h3 style="margin:6px 0 8px">Withdrawal requests</h3><div class="note">Send the money from your own UPI or bank app first, then tap <b>Mark as paid</b>. Tap Reject to return the money to the companion\'s wallet.</div>' +
    (D.wds.map(function (w) { var u = byId(w.user_id); return '<div class="card"><div class="line"><b>' + rs(w.amount) + ' to ' + esc(u.full_name) + '</b><span class="pill ' + pc(w.status) + '">' + w.status + '</span></div><div class="meta">UPI: <b>' + esc(w.upi) + '</b> · requested ' + when(w.created_at) + '</div>' + (w.status === "pending" ? '<div class="acts"><button class="btn good" data-a="wdpay" data-v="' + w.id + '">Mark as paid</button><button class="btn bad" data-a="wdrej" data-v="' + w.id + '">Reject</button></div>' : (w.note ? '<div class="meta">Note: ' + esc(w.note) + '</div>' : "")) + '</div>'; }).join("") || '<div class="card meta">No withdrawal requests.</div>') +
    '<h3 style="margin:16px 0 8px">Recent payments</h3>' + (D.payments.slice(0, 30).map(function (p) { return '<div class="card"><div class="line"><b>' + rs(p.amount) + '</b><span class="pill ' + pc(p.status) + '">' + p.status + '</span></div><div class="meta">' + esc(p.razorpay_payment_id || "") + ' · ' + when(p.created_at) + '</div></div>'; }).join("") || '<div class="card meta">No payments yet.</div>');
};
V.safety = function () {
  return '<h2 class="t">Safety alerts</h2>' + (D.alerts.map(function (a) {
    var u = byId(a.user_id), map = (a.lat != null && a.lng != null) ? ' · <a href="https://www.google.com/maps?q=' + a.lat + ',' + a.lng + '" target="_blank" rel="noopener">View location</a>' : " · no location";
    return '<div class="card"><div class="line"><b>' + esc(a.type) + ' · ' + esc(u.full_name) + '</b><span class="pill ' + pc(a.status) + '">' + a.status + '</span></div><div class="meta">' + esc(a.note || "") + ' · ' + when(a.created_at) + map + '</div>' +
      '<div class="meta">Phone: <a href="tel:+91' + esc(u.mobile || "") + '">' + esc(u.mobile || "-") + '</a> · Emergency contact: ' + esc(u.emergency_name || "-") + ' <a href="tel:+91' + esc(u.emergency_mobile || "") + '">' + esc(u.emergency_mobile || "") + '</a></div>' +
      (a.status === "open" ? '<div class="acts"><button class="btn good" data-a="resolve" data-v="' + a.id + '">Mark resolved</button></div>' : "") + '</div>';
  }).join("") || '<div class="card meta">No alerts. 🎉</div>');
};
V.settings = function () {
  var fld = function (l, k) { return '<div class="fld"><label for="c_' + k + '">' + l + '</label><input class="in" id="c_' + k + '" data-c="' + k + '" type="number" min="0" value="' + D.set[k] + '"></div>'; };
  return '<h2 class="t">Settings</h2><div class="card"><b>Your business rules</b>' + fld("Platform commission on companion earnings (%)", "commission_pct") + fld("Safety and service fee added for renters (%)", "fee_pct") + fld("Minimum withdrawal (₹)", "min_withdrawal") +
    '<p class="meta">New values apply to <b>new</b> bookings only.</p><button class="btn" data-a="saveset">Save settings</button></div>' +
    '<div class="card"><b>2-step verification</b><p class="meta">Strongly recommended for your admin account. You need an authenticator app (Google Authenticator, Authy, etc.).</p><div id="mfaArea"><button class="btn" data-a="mfa">Set up 2-step verification</button></div></div>' +
    '<div class="card"><b>Recent admin activity</b>' + (D.audit.map(function (x) { return '<div class="rowkv"><span>' + esc(x.action) + ' <span class="meta">' + esc((x.target || "").slice(0, 8)) + '</span></span><span class="meta">' + when(x.created_at) + '</span></div>'; }).join("") || '<p class="meta">Nothing yet.</p>') + '</div>';
};

/* ---------- sheets ---------- */
function open(t, html) { $("shT").textContent = t; $("shB").innerHTML = html; $("sheet").classList.add("open"); $("scrim").classList.add("open"); }
function close() { $("sheet").classList.remove("open"); $("scrim").classList.remove("open"); }
function kv(rows) { return rows.map(function (r) { return '<div class="rowkv"><span class="meta">' + r[0] + '</span><span style="text-align:right">' + esc(r[1]) + '</span></div>'; }).join(""); }
function userSheet(id) {
  var u = byId(id), c = D.comps.filter(function (x) { return x.user_id === id; })[0], n = D.bookings.filter(function (b) { return b.renter_id === id || b.companion_id === id; }).length;
  open(u.full_name,
    '<div class="line"><span class="meta">' + esc(u.id.slice(0, 8)) + '</span><span class="pill ' + pc(u.status) + '">' + u.status + '</span></div>' +
    kv([["Email", u.email], ["Mobile", "+91 " + (u.mobile || "-") + (u.mobile_verified ? " (verified)" : " (not verified)")], ["Date of birth", u.dob || "-"], ["Gender", u.gender || "-"], ["State", u.state || "-"], ["City", u.city || "-"], ["ID type", u.id_type || "-"], ["Emergency contact", (u.emergency_name || "-") + " · " + (u.emergency_mobile || "")], ["Rules accepted", when(u.rules_accepted_at)], ["Joined", when(u.created_at)], ["Bookings", n]].concat(c ? [["Services", (c.services || []).join(", ")], ["Rate", rs(c.rate) + "/hr"], ["Caretaker approved", c.caretaker_verified ? "Yes" : "No"]] : [])) +
    (u.reject_reason ? '<p class="meta">Reject reason: ' + esc(u.reject_reason) + '</p>' : "") +
    '<div class="acts">' + (u.id_path ? '<button class="btn alt" data-a="viewid" data-v="' + esc(u.id_path) + '|' + u.id + '">View ID (60 sec link)</button>' : '<span class="meta">No ID uploaded</span>') +
    (c && c.police_cert_path ? '<button class="btn alt" data-a="viewid" data-v="' + esc(c.police_cert_path) + '|' + u.id + '">View police certificate</button>' : "") + '</div>' +
    '<div class="acts"><button class="btn good" data-a="ust" data-v="' + id + '|verified">Approve</button><button class="btn bad" data-a="ust" data-v="' + id + '|rejected">Reject</button><button class="btn alt" data-a="ust" data-v="' + id + '|suspended">Suspend</button>' +
    (c && (c.services || []).indexOf("Caretaker") > -1 ? '<button class="btn alt" data-a="care" data-v="' + id + '|' + (c.caretaker_verified ? "0" : "1") + '">' + (c.caretaker_verified ? "Remove caretaker approval" : "Approve as caretaker") + '</button>' : "") + '</div>');
}
function bkSheet(id) {
  var b = D.bookings.filter(function (x) { return x.id === id; })[0];
  open("Booking " + b.id.slice(0, 8),
    kv([["Status", b.status], ["Service", b.service], ["Renter", b.renter_name + " (" + byId(b.renter_id).mobile + ")"], ["Companion", b.companion_name + " (" + byId(b.companion_id).mobile + ")"], ["When", when(b.starts_at)], ["Venue", b.venue_type + ", " + b.venue_name], ["Duration", b.hours + " hr at " + rs(b.rate) + "/hr"], ["Booking amount", rs(b.gross)], ["Renter paid (fee " + rs(b.fee) + ")", rs(b.total)], ["Companion gets", rs(b.net)], ["Your earning", rs(b.fee + b.commission)], ["Razorpay payment", b.razorpay_payment_id || "-"]]) +
    ((["paid", "accepted", "in_progress"].indexOf(b.status) > -1) ? '<div class="acts"><button class="btn bad" data-a="adminrefund" data-v="' + b.id + '">Refund renter</button>' + (b.status === "in_progress" ? '<button class="btn good" data-a="admincomplete" data-v="' + b.id + '">Mark complete and pay companion</button>' : "") + '</div>' : ""));
}

/* ---------- actions ---------- */
var A = {};
A.tab = function (v) { S.tab = v; render(); window.scrollTo(0, 0); };
A.uf = function (v) { S.uf = v; render(); };
A.bf = function (v) { S.bf = v; render(); };
A.user = userSheet; A.bk = bkSheet; A.close = close;
A.reload = async function () { await loadAll(); render(); toast("Updated."); };
A.signout = async function () { await sb.auth.signOut(); location.reload(); };
A.viewid = async function (v) {
  var p = v.split("|"), r = await sb.storage.from("kyc").createSignedUrl(p[0], 60);
  if (r.error) return fail(r.error);
  await audit("view_document", p[1]); window.open(r.data.signedUrl, "_blank", "noopener");
};
A.ust = async function (v) {
  var p = v.split("|"), patch = { status: p[1] };
  if (p[1] === "rejected") { var why = window.prompt("Reason shown to the user (for example: ID photo is blurry):", ""); if (why === null) return; patch.reject_reason = why; } else { patch.reject_reason = null; }
  var r = await sb.from("profiles").update(patch).eq("id", p[0]); if (r.error) return fail(r.error);
  await audit("user_" + p[1], p[0]); await loadAll(); close(); render(); toast("Account marked " + p[1] + ".");
};
A.care = async function (v) {
  var p = v.split("|"), r = await sb.from("companion_profiles").update({ caretaker_verified: p[1] === "1" }).eq("user_id", p[0]); if (r.error) return fail(r.error);
  await audit("caretaker_" + (p[1] === "1" ? "approved" : "removed"), p[0]); await loadAll(); close(); render();
};
A.wdpay = async function (v) { var r = await sb.rpc("admin_mark_withdrawal", { p_id: v, p_status: "paid", p_note: null }); if (r.error) return fail(r.error); await loadAll(); render(); toast("Marked as paid."); };
A.wdrej = async function (v) { var n = window.prompt("Reason (optional):", ""); if (n === null) return; var r = await sb.rpc("admin_mark_withdrawal", { p_id: v, p_status: "rejected", p_note: n }); if (r.error) return fail(r.error); await loadAll(); render(); toast("Rejected. Money returned to wallet."); };
A.resolve = async function (v) { var r = await sb.from("alerts").update({ status: "resolved" }).eq("id", v); if (r.error) return fail(r.error); await audit("alert_resolved", v); await loadAll(); render(); };
A.saveset = async function () {
  var c = D.set, r = await sb.from("settings").update({ commission_pct: c.commission_pct, fee_pct: c.fee_pct, min_withdrawal: c.min_withdrawal }).eq("id", 1);
  if (r.error) return fail(r.error); await audit("settings_changed", "commission=" + c.commission_pct + ",fee=" + c.fee_pct + ",min=" + c.min_withdrawal); toast("Saved.");
};
A.adminrefund = async function (v) {
  if (!window.confirm("Refund this booking to the renter?")) return;
  var r = await sb.functions.invoke(((cfg.FUNCTIONS || {})["refund-booking"]) || "refund-booking", { body: { action: "refund-booking", booking_id: v } });
  if (r.error) { var m = "Refund failed"; try { m = (await r.error.context.json()).error || m; } catch (e) {} return toast(m); }
  await loadAll(); close(); render(); toast("Refund started.");
};
A.admincomplete = async function (v) { var r = await sb.rpc("complete_booking", { p_id: v }); if (r.error) return fail(r.error); await audit("admin_complete", v); await loadAll(); close(); render(); toast("Completed. Companion wallet credited."); };
A.mfa = async function () {
  var r = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Yaari admin" }); if (r.error) return fail(r.error);
  $("mfaArea").innerHTML = '<p class="meta">Scan this QR code in your authenticator app, then type the 6-digit code below.</p><img alt="QR code" style="width:180px;height:180px;background:#fff;border-radius:10px" src="' + r.data.totp.qr_code + '"><p class="meta">Or enter this key manually: <b>' + esc(r.data.totp.secret) + '</b></p><input class="in" id="mfaCode" inputmode="numeric" maxlength="6" placeholder="6-digit code"><button class="btn" data-a="mfaok" data-v="' + r.data.id + '">Turn on</button>';
};
A.mfaok = async function (v) {
  var code = $("mfaCode").value.trim(), ch = await sb.auth.mfa.challenge({ factorId: v }); if (ch.error) return fail(ch.error);
  var vr = await sb.auth.mfa.verify({ factorId: v, challengeId: ch.data.id, code: code }); if (vr.error) return toast("Wrong code. Try again.");
  await audit("mfa_enabled", D.me.id); toast("2-step verification is on. You will need a code at every sign in.");
};

document.addEventListener("click", function (e) {
  var el = e.target.closest("[data-a]"); if (!el || !A[el.dataset.a]) return;
  Promise.resolve().then(function () { return A[el.dataset.a](el.dataset.v); }).catch(fail);
});
document.addEventListener("input", function (e) {
  var t = e.target;
  if (t.id === "q") { S.q = t.value; var pos = t.selectionStart; render(); var q = $("q"); q.focus(); q.setSelectionRange(pos, pos); }
  if (t.dataset.c) D.set[t.dataset.c] = Math.max(0, parseFloat(t.value) || 0);
});
$("go").onclick = function () { signIn().catch(function (e) { $("lerr").textContent = e.message; }); };
$("pw").addEventListener("keydown", function (e) { if (e.key === "Enter") $("go").click(); });
$("scrim").onclick = close;
document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
})();
