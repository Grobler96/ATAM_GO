-- Sender mailboxes for quote chase emails (applied 21 Oct 2026). Daniel's IT team confirmed the "ATAM GO Mailer" app is
-- restricted (Exchange RBAC for Applications) to these eight mailboxes. rep_name must match quotes.assigned_to exactly.
-- Not added: chris.spooner@atam.co.uk (IT included it, but no quote is assigned to a Chris Spooner; add it here once we
-- know who it is for).
insert into public.mail_senders (label, email, kind, rep_name) values
 ('Daniel Spooner', 'daniel.spooner@atam.co.uk', 'rep', 'Daniel Spooner'),
 ('Bethan Kaye', 'bethan.kaye@atam.co.uk', 'rep', 'Bethan Kaye'),
 ('Emma Harman', 'emma.harman@atam.co.uk', 'rep', 'Emma Harman'),
 ('Julie Sheehan', 'julie.sheehan@atam.co.uk', 'rep', 'Julie Sheehan'),
 ('Christine Ball', 'christine.ball@atam.co.uk', 'rep', 'Christine Ball'),
 ('Francesca Spooner', 'francesca.spooner@atam.co.uk', 'rep', 'Francesca Spooner'),
 ('ATAM Support (shared)', 'support@atam.co.uk', 'shared', null)
on conflict (email) do nothing;
