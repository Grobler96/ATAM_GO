-- The dedicated "phone" login DAN uses on calls and for the morning brief.
-- 1) In Supabase: Authentication -> Users -> Add user (email + a long random password, auto confirm). Put the same email and
--    password in the worker settings (DAN_VOICE_EMAIL / DAN_VOICE_PASSWORD).
-- 2) Then run this, with that email, so the account can read everything (and so anything done by phone is recorded as Daniel, by phone):
update public.profiles
   set is_superuser = true, full_name = 'Daniel Spooner (by phone)'
 where lower(email) = lower('PHONE-LOGIN-EMAIL-HERE');
-- Check it took (should return one row):
-- select id, email, full_name, is_superuser from public.profiles where lower(email) = lower('PHONE-LOGIN-EMAIL-HERE');
