-- A number whose signed statements are authentic and chain correctly but break a business rule
-- (sequence, date, council, record checks, reissue of an infringement no longer issued) is kept
-- in the key's chain and marked rejected, so the handset's later statements still follow it.
alter table infringements drop constraint if exists infringements_status_check;
alter table infringements add constraint infringements_status_check
  check (status in ('allocated', 'issued', 'cancelled', 'void_requested', 'voided', 'paid', 'rejected'));
alter table infringements add column if not exists rejection jsonb;
