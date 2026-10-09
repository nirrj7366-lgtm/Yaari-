-- YAARI database, PART 1 of 4: Tables
-- Run the parts in order: 1, 2, 3, 4

-- =====================================================================
-- YAARI: complete database schema, security rules and server functions
-- Run this whole file once in Supabase: SQL Editor -> New query -> Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- business settings (only admin can change) ----------------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  commission_pct numeric not null default 15 check (commission_pct between 0 and 60),
  fee_pct        numeric not null default 5  check (fee_pct between 0 and 30),
  min_withdrawal int     not null default 500 check (min_withdrawal >= 100)
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------- admins ---------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  admin_id uuid,
  action text not null,
  target text,
  created_at timestamptz not null default now()
);

-- ---------- profiles -------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text,
  mobile text,
  mobile_verified boolean not null default false,
  dob date,
  gender text,
  city text,
  state text,
  id_type text,
  id_path text,
  emergency_name text,
  emergency_mobile text,
  rules_accepted_at timestamptz,
  status text not null default 'incomplete'
    check (status in ('incomplete','pending','verified','rejected','suspended')),
  reject_reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.companion_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  services text[] not null default '{}',
  rate int not null check (rate between 100 and 5000),
  bio text,
  days text[] not null default '{}',
  active boolean not null default true,
  caretaker_verified boolean not null default false,
  police_cert_path text
);

-- ---------- bookings, payments, wallet ------------------------------
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  renter_id uuid not null references public.profiles(id),
  companion_id uuid not null references public.profiles(id),
  renter_name text,
  companion_name text,
  service text not null,
  hours int not null check (hours between 1 and 4),
  starts_at timestamptz not null,
  venue_type text not null,
  venue_name text not null,
  rate int not null,
  gross int not null,
  fee int not null,
  commission int not null,
  net int not null,
  total int not null,
  status text not null default 'pending_payment'
    check (status in ('pending_payment','paid','accepted','in_progress','completed','refunded','cancelled')),
  razorpay_order_id text unique,
  razorpay_payment_id text unique,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- The check-in code is kept apart so the companion can never read it
create table if not exists public.booking_codes (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  code text not null
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id),
  razorpay_order_id text,
  razorpay_payment_id text unique,
  amount int not null,
  status text not null default 'captured',
  created_at timestamptz not null default now()
);

create table if not exists public.wallet_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id),
  booking_id uuid references public.bookings(id),
  amount int not null,               -- + earning, - withdrawal
  type text not null,                -- earning | withdrawal | withdrawal_reversal
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  amount int not null,
  upi text not null,
  status text not null default 'pending' check (status in ('pending','paid','rejected')),
  note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  booking_id uuid references public.bookings(id),
  type text not null default 'SOS' check (type in ('SOS','Report')),
  note text,
  lat double precision,
  lng double precision,
  status text not null default 'open' check (status in ('open','resolved')),
  created_at timestamptz not null default now()
);

create index if not exists bookings_renter_idx on public.bookings(renter_id);
create index if not exists bookings_companion_idx on public.bookings(companion_id);
create index if not exists ledger_user_idx on public.wallet_ledger(user_id);
-- YAARI database, PART 2 of 4: Triggers-and-views
-- Run the parts in order: 1, 2, 3, 4

-- ---------- new user -> profile row ---------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, mobile)
  values (new.id,
          coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), 'New user'),
          new.email,
          new.raw_user_meta_data->>'mobile');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- keep "mobile verified" in sync when Supabase confirms a phone OTP
create or replace function public.sync_phone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.phone is not null and new.phone_confirmed_at is not null then
    update public.profiles
       set mobile = right(new.phone, 10), mobile_verified = true
     where id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_phone on auth.users;
create trigger on_auth_user_phone after update of phone_confirmed_at on auth.users
  for each row execute function public.sync_phone();

-- ---------- guards: stop users from editing protected fields --------
create or replace function public.guard_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.dob is not null and date_part('year', age(new.dob)) < 18 then
    raise exception 'You must be 18 or older to use Yaari';
  end if;
  if auth.uid() is null then return new; end if;            -- system / service role
  if tg_op = 'UPDATE' and not public.is_admin() then
    if new.mobile_verified is distinct from old.mobile_verified
       or new.email is distinct from old.email
       or new.reject_reason is distinct from old.reject_reason then
      raise exception 'Protected field';
    end if;
    if new.status is distinct from old.status then
      if not (new.status = 'pending' and old.status in ('incomplete','rejected')) then
        raise exception 'Status can only be changed by Yaari';
      end if;
      if new.dob is null or new.city is null or new.gender is null or new.id_type is null
         or new.emergency_name is null or new.emergency_mobile is null
         or new.rules_accepted_at is null then
        raise exception 'Please complete every field before submitting';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_profile_trg on public.profiles;
create trigger guard_profile_trg before insert or update on public.profiles
  for each row execute function public.guard_profile();

create or replace function public.guard_companion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    new.caretaker_verified := false;
  elsif new.caretaker_verified is distinct from old.caretaker_verified then
    raise exception 'Protected field';
  end if;
  return new;
end $$;

drop trigger if exists guard_companion_trg on public.companion_profiles;
create trigger guard_companion_trg before insert or update on public.companion_profiles
  for each row execute function public.guard_companion();

-- ---------- public listing (limited columns, verified people only) --
create or replace view public.public_companions as
select p.id,
       split_part(p.full_name, ' ', 1) as first_name,
       date_part('year', age(p.dob))::int as age,
       p.city,
       p.gender,
       case when c.caretaker_verified then c.services
            else array_remove(c.services, 'Caretaker') end as services,
       c.rate, c.bio, c.days, c.caretaker_verified, p.state
from public.profiles p
join public.companion_profiles c on c.user_id = p.id
where p.status = 'verified'
  and c.active
  and p.id <> auth.uid()
  and exists (select 1 from public.profiles me where me.id = auth.uid() and me.status = 'verified');

-- ---------- which venue types are allowed for each service ----------
create or replace function public.venue_ok(s text, v text)
returns boolean language sql immutable as $$
  select case s
    when 'Shopping'     then v in ('Mall / Market','Cafe / Restaurant')
    when 'Movie'        then v in ('Cinema hall','Cafe / Restaurant')
    when 'Club & Party' then v in ('Registered club / lounge','Banquet / Party venue')
    when 'Wedding'      then v in ('Wedding venue / Banquet')
    when 'Study'        then v in ('Library / Study cafe','Cafe / Restaurant')
    when 'Play'         then v in ('Sports ground / Park','Gaming cafe / Arcade','Board-game cafe')
    when 'Caretaker'    then v in ('Home (verified caretakers only)','Hospital / Clinic','Park (walks)')
    else false end
$$;
-- YAARI database, PART 3 of 4: Server-functions
-- Run the parts in order: 1, 2, 3, 4

-- =====================================================================
-- SERVER FUNCTIONS (the only way to create or change money-related rows)
-- =====================================================================

create or replace function public.create_booking(
  p_companion uuid, p_service text, p_hours int, p_start timestamptz,
  p_venue_type text, p_venue_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me public.profiles; comp public.profiles; cp public.companion_profiles; s public.settings;
  g int; f int; c int; bid uuid;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or me.status <> 'verified' then raise exception 'Your account is not verified yet'; end if;
  if p_companion = auth.uid() then raise exception 'You cannot book yourself'; end if;

  select * into comp from public.profiles where id = p_companion and status = 'verified';
  select * into cp from public.companion_profiles where user_id = p_companion and active;
  if comp.id is null or cp.user_id is null then raise exception 'This companion is not available'; end if;
  if not (p_service = any (cp.services)) then raise exception 'This service is not offered'; end if;
  if p_service = 'Caretaker' and not cp.caretaker_verified then raise exception 'Caretaker is not verified yet'; end if;
  if not public.venue_ok(p_service, p_venue_type) then raise exception 'That venue type is not allowed for this service'; end if;
  if p_hours < 1 or p_hours > 4 then raise exception 'Choose 1 to 4 hours'; end if;
  if p_start < now() + interval '1 hour' then raise exception 'Choose a time at least 1 hour from now'; end if;
  if length(trim(coalesce(p_venue_name, ''))) < 3 then raise exception 'Enter the venue name'; end if;

  select * into s from public.settings where id = 1;
  g := cp.rate * p_hours;
  f := round(g * s.fee_pct / 100);
  c := round(g * s.commission_pct / 100);

  insert into public.bookings (renter_id, companion_id, renter_name, companion_name, service, hours,
                               starts_at, venue_type, venue_name, rate, gross, fee, commission, net, total)
  values (auth.uid(), p_companion, split_part(me.full_name, ' ', 1), split_part(comp.full_name, ' ', 1),
          p_service, p_hours, p_start, p_venue_type, trim(p_venue_name), cp.rate, g, f, c, g - c, g + f)
  returning id into bid;

  insert into public.booking_codes (booking_id, code)
  values (bid, lpad((floor(random() * 10000))::int::text, 4, '0'));
  return bid;
end $$;

create or replace function public.cancel_unpaid(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set status = 'cancelled'
   where id = p_id and renter_id = auth.uid() and status = 'pending_payment';
end $$;

create or replace function public.accept_booking(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set status = 'accepted'
   where id = p_id and companion_id = auth.uid() and status = 'paid';
  if not found then raise exception 'This request can no longer be accepted'; end if;
end $$;

create or replace function public.start_booking(p_id uuid, p_code text)
returns void language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  select exists (select 1 from public.booking_codes where booking_id = p_id and code = trim(p_code)) into ok;
  if not ok then raise exception 'Wrong check-in code'; end if;
  update public.bookings set status = 'in_progress'
   where id = p_id and companion_id = auth.uid() and status = 'accepted';
  if not found then raise exception 'This booking cannot be started'; end if;
end $$;

create or replace function public.complete_booking(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_id for update;
  if b.id is null then raise exception 'Booking not found'; end if;
  if not (b.renter_id = auth.uid() or public.is_admin()) then raise exception 'Not allowed'; end if;
  if b.status <> 'in_progress' then raise exception 'The meeting has not started yet'; end if;
  update public.bookings set status = 'completed', completed_at = now() where id = p_id;
  insert into public.wallet_ledger (user_id, booking_id, amount, type, note)
  values (b.companion_id, b.id, b.net, 'earning', b.service || ' with ' || coalesce(b.renter_name, 'a renter'));
end $$;

create or replace function public.my_balance()
returns int language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0)::int from public.wallet_ledger where user_id = auth.uid()
$$;

create or replace function public.request_withdrawal(p_amount int, p_upi text)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.settings; bal int; wid uuid;
begin
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select * into s from public.settings where id = 1;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'verified') then
    raise exception 'Your account is not verified';
  end if;
  if p_amount < s.min_withdrawal then raise exception 'Minimum withdrawal is Rs %', s.min_withdrawal; end if;
  if p_upi !~ '^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}$' then raise exception 'Enter a valid UPI ID'; end if;
  select coalesce(sum(amount), 0) into bal from public.wallet_ledger where user_id = auth.uid();
  if p_amount > bal then raise exception 'Amount is more than your balance'; end if;
  insert into public.withdrawals (user_id, amount, upi) values (auth.uid(), p_amount, trim(p_upi)) returning id into wid;
  insert into public.wallet_ledger (user_id, amount, type, note) values (auth.uid(), -p_amount, 'withdrawal', 'Withdrawal to ' || trim(p_upi));
  return wid;
end $$;

create or replace function public.admin_mark_withdrawal(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare w public.withdrawals;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_status not in ('paid','rejected') then raise exception 'Bad status'; end if;
  select * into w from public.withdrawals where id = p_id for update;
  if w.id is null or w.status <> 'pending' then raise exception 'Already handled'; end if;
  update public.withdrawals
     set status = p_status, note = p_note, paid_at = case when p_status = 'paid' then now() end
   where id = p_id;
  if p_status = 'rejected' then
    insert into public.wallet_ledger (user_id, amount, type, note)
    values (w.user_id, w.amount, 'withdrawal_reversal', 'Withdrawal rejected');
  end if;
  insert into public.audit_log (admin_id, action, target) values (auth.uid(), 'withdrawal_' || p_status, p_id::text);
end $$;
-- YAARI database, PART 4 of 4: Security-rules-and-permissions
-- Run the parts in order: 1, 2, 3, 4

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.settings           enable row level security;
alter table public.admins             enable row level security;
alter table public.audit_log          enable row level security;
alter table public.profiles           enable row level security;
alter table public.companion_profiles enable row level security;
alter table public.bookings           enable row level security;
alter table public.booking_codes      enable row level security;
alter table public.payments           enable row level security;
alter table public.wallet_ledger      enable row level security;
alter table public.withdrawals        enable row level security;
alter table public.alerts             enable row level security;

-- settings
create policy settings_read  on public.settings for select to authenticated using (true);
create policy settings_admin on public.settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- admins (you can only see your own row)
create policy admins_self on public.admins for select to authenticated using (user_id = auth.uid());

-- audit log
create policy audit_admin_read   on public.audit_log for select to authenticated using (public.is_admin());
create policy audit_admin_insert on public.audit_log for insert to authenticated with check (public.is_admin() and admin_id = auth.uid());

-- profiles
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_update_own on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_update_admin on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- companion profiles
create policy comp_select on public.companion_profiles for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy comp_insert on public.companion_profiles for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and status = 'verified'));
create policy comp_update on public.companion_profiles for update to authenticated
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

-- bookings (read only; all changes go through the server functions above)
create policy bookings_select on public.bookings for select to authenticated
  using (renter_id = auth.uid()
         or (companion_id = auth.uid() and status <> 'pending_payment')
         or public.is_admin());

-- check-in code: only the renter sees it
create policy codes_renter on public.booking_codes for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.renter_id = auth.uid()));

-- payments
create policy payments_select on public.payments for select to authenticated
  using (public.is_admin() or exists (select 1 from public.bookings b where b.id = booking_id and b.renter_id = auth.uid()));

-- wallet
create policy ledger_select on public.wallet_ledger for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- withdrawals
create policy wd_select on public.withdrawals for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- alerts
create policy alerts_insert on public.alerts for insert to authenticated with check (user_id = auth.uid());
create policy alerts_select on public.alerts for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy alerts_admin_update on public.alerts for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- STORAGE: private bucket for ID documents
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc', 'kyc', false, 5242880, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

create policy kyc_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'kyc' and (storage.foldername(name))[1] = auth.uid()::text);
create policy kyc_update on storage.objects for update to authenticated
  using (bucket_id = 'kyc' and (storage.foldername(name))[1] = auth.uid()::text);
create policy kyc_select on storage.objects for select to authenticated
  using (bucket_id = 'kyc' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- =====================================================================
-- PERMISSIONS
-- =====================================================================
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated, service_role;

revoke all on public.public_companions from anon;
grant select on public.public_companions to authenticated;

-- =====================================================================
-- MAKE YOURSELF ADMIN (do this AFTER you sign up once on the site):
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'YOUR-EMAIL@example.com';
-- =====================================================================



