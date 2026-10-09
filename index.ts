// Yaari: ONE Edge Function for payments (create-order, verify-payment, refund-booking and the Razorpay webhook)
// Paste this WHOLE file into your function's Code tab and press Deploy.

import { createClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** Database client that bypasses row-level security. Server-side only. */
export function adminDb() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

/** The signed-in user who called this function (from their login token). */
export async function authUser(req: Request) {
  const c = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data } = await c.auth.getUser();
  return data.user;
}

export function rzAuth() {
  return "Basic " + btoa(`${Deno.env.get("RAZORPAY_KEY_ID")}:${Deno.env.get("RAZORPAY_KEY_SECRET")}`);
}

export async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Marks a booking as paid. Safe to call twice (webhook + browser both call it). */
// deno-lint-ignore no-explicit-any
export async function markPaid(db: any, orderId: string, paymentId: string) {
  const { data: b } = await db.from("bookings").select("*").eq("razorpay_order_id", orderId).maybeSingle();
  if (!b) return null;
  if (b.status === "pending_payment") {
    await db.from("bookings")
      .update({ status: "paid", razorpay_payment_id: paymentId })
      .eq("id", b.id).eq("status", "pending_payment");
    await db.from("payments").upsert(
      { booking_id: b.id, razorpay_order_id: orderId, razorpay_payment_id: paymentId, amount: b.total, status: "captured" },
      { onConflict: "razorpay_payment_id" },
    );
  }
  return b;
}


// ---------------------------------------------------------------
// One function that does everything. The site sends { action: "..." }
// ---------------------------------------------------------------

async function createOrder(req: Request, body: any) {
  const user = await authUser(req);
  if (!user) return json({ error: "Please log in again" }, 401);
  const db = adminDb();
  const { data: b } = await db.from("bookings").select("*").eq("id", body.booking_id).maybeSingle();
  if (!b || b.renter_id !== user.id) return json({ error: "Booking not found" }, 404);
  if (b.status !== "pending_payment") return json({ error: "This booking is not waiting for payment" }, 400);

  // The amount comes from OUR database, never from the browser.
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: rzAuth(), "Content-Type": "application/json" },
    body: JSON.stringify({ amount: b.total * 100, currency: "INR", receipt: b.id, notes: { booking_id: b.id } }),
  });
  const order = await res.json();
  if (!res.ok) return json({ error: order?.error?.description ?? "Razorpay error" }, 502);
  await db.from("bookings").update({ razorpay_order_id: order.id }).eq("id", b.id);
  return json({ order_id: order.id, amount: order.amount, key_id: Deno.env.get("RAZORPAY_KEY_ID") });
}

async function verifyPayment(req: Request, body: any) {
  const user = await authUser(req);
  if (!user) return json({ error: "Please log in again" }, 401);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return json({ error: "Missing payment details" }, 400);
  const expected = await hmacHex(Deno.env.get("RAZORPAY_KEY_SECRET")!, `${razorpay_order_id}|${razorpay_payment_id}`);
  if (!safeEqual(expected, razorpay_signature)) return json({ error: "Payment signature is invalid" }, 400);
  const db = adminDb();
  const { data: b } = await db.from("bookings").select("renter_id").eq("razorpay_order_id", razorpay_order_id).maybeSingle();
  if (!b || b.renter_id !== user.id) return json({ error: "Booking not found" }, 404);
  await markPaid(db, razorpay_order_id, razorpay_payment_id);
  return json({ ok: true });
}

async function refundBooking(req: Request, body: any) {
  const user = await authUser(req);
  if (!user) return json({ error: "Please log in again" }, 401);
  const db = adminDb();
  const { data: b } = await db.from("bookings").select("*").eq("id", body.booking_id).maybeSingle();
  if (!b) return json({ error: "Booking not found" }, 404);
  const { data: adm } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  const isAdmin = !!adm;
  const isParty = b.renter_id === user.id || b.companion_id === user.id;
  if (!isAdmin && !isParty) return json({ error: "Not allowed" }, 403);
  const okStatuses = isAdmin ? ["paid", "accepted", "in_progress"] : ["paid", "accepted"];
  if (!okStatuses.includes(b.status)) return json({ error: "This booking can no longer be refunded" }, 400);
  if (!b.razorpay_payment_id) return json({ error: "No payment found for this booking" }, 400);

  const { data: locked } = await db.from("bookings").update({ status: "refunded" }).eq("id", b.id).in("status", okStatuses).select("id");
  if (!locked || locked.length === 0) return json({ error: "Already handled" }, 409);

  const res = await fetch(`https://api.razorpay.com/v1/payments/${b.razorpay_payment_id}/refund`, {
    method: "POST",
    headers: { Authorization: rzAuth(), "Content-Type": "application/json" },
    body: JSON.stringify({ notes: { booking_id: b.id } }),
  });
  const out = await res.json();
  if (!res.ok) {
    await db.from("bookings").update({ status: b.status }).eq("id", b.id);
    return json({ error: out?.error?.description ?? "Refund failed" }, 502);
  }
  await db.from("payments").update({ status: "refunded" }).eq("razorpay_payment_id", b.razorpay_payment_id);
  if (isAdmin) await db.from("audit_log").insert({ admin_id: user.id, action: "refund", target: b.id });
  return json({ ok: true });
}

async function webhook(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-razorpay-signature") ?? "";
  const expected = await hmacHex(Deno.env.get("RAZORPAY_WEBHOOK_SECRET")!, raw);
  if (!safeEqual(expected, sig)) return new Response("bad signature", { status: 400 });
  const event = JSON.parse(raw);
  if (event.event === "payment.captured" || event.event === "order.paid") {
    const p = event.payload?.payment?.entity;
    if (p?.order_id && p?.id) await markPaid(adminDb(), p.order_id, p.id);
  }
  return new Response("ok");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.headers.get("x-razorpay-signature")) return await webhook(req);
    const body = await req.json();
    switch (body.action) {
      case "create-order": return await createOrder(req, body);
      case "verify-payment": return await verifyPayment(req, body);
      case "refund-booking": return await refundBooking(req, body);
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
