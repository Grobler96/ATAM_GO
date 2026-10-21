-- Added 21 Oct 2026 (applied): Chris Spooner's mailbox was in IT's list of eight allowed mailboxes. No quote is assigned to a
-- Chris Spooner yet; rep_name must match quotes.assigned_to exactly once there is one. Until then this mailbox can be picked by hand
-- in the From box.
insert into public.mail_senders (label, email, kind, rep_name) values
 ('Chris Spooner', 'chris.spooner@atam.co.uk', 'rep', 'Chris Spooner')
on conflict (email) do nothing;
