-- PlateWatch backend — initial schema (docs/BACKEND.md).
-- Development and field-testing backend standing in for EnforcementMAPS / CommandMAPS.

create table if not exists devices (
  key_id          text primary key,                 -- first 16 hex of SHA-256(canonical public JWK)
  public_jwk      jsonb not null,
  label           text not null default '',
  officer_number  text not null default '',
  status          text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  registered_at   timestamptz not null default now(),
  decided_by      text,
  decided_at      timestamptz,
  last_seen_at    timestamptz
);

-- Every statement a device key has signed, in chain order. The server never creates numbers.
create table if not exists statements (
  hash            text primary key,                 -- SHA-256 of the canonical statement
  key_id          text not null references devices (key_id),
  type            text not null check (type in ('allocation', 'issue', 'cancel')),
  number          text not null,
  prev_hash       text not null,
  statement       jsonb not null,
  signature       text not null,
  received_at     timestamptz not null default now()
);
create unique index if not exists statements_prev_unique on statements (key_id, prev_hash);
create unique index if not exists statements_allocation_number on statements (number) where type = 'allocation';
create unique index if not exists statements_closing_number on statements (number) where type <> 'allocation';

create table if not exists chain_heads (
  key_id          text primary key references devices (key_id),
  head_hash       text not null
);

-- Daily pools: officer + date → last accepted sequence.
create table if not exists pools (
  officer         text not null,
  day             text not null,                    -- YYMMDD
  last_sequence   integer not null,
  primary key (officer, day)
);

create table if not exists scans (
  id              text primary key,
  device_key_id   text,
  officer_number  text,
  list_id         text,
  plate           text not null,
  plate_key       text not null,
  outcome         text not null,
  captured_at     timestamptz not null,
  lat             double precision,
  lng             double precision,
  accuracy_m      double precision,
  sha256          text not null,
  observation_id  text,
  thumb_jpeg      bytea,
  data            jsonb not null,
  received_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists scans_captured on scans (captured_at desc);
create index if not exists scans_plate on scans (plate_key);

create table if not exists evidence (
  scan_id         text primary key,
  sha256          text not null,
  mime            text not null,
  bytes           bytea not null,
  received_at     timestamptz not null default now()
);

create table if not exists observations (
  id              text primary key,
  device_key_id   text,
  list_id         text,
  plate           text not null,
  status          text not null,
  started_at      timestamptz not null,
  data            jsonb not null,
  updated_at      timestamptz not null default now()
);

create table if not exists hot_events (
  id                 text primary key,
  device_key_id      text,
  kind               text not null,
  plate              text not null,
  plate_key          text not null,
  hot_list_entry_id  text not null,
  scan_id            text,
  at                 timestamptz not null,
  officer_number     text not null,
  lat                double precision,
  lng                double precision,
  accuracy_m         double precision,
  data               jsonb not null,
  received_at        timestamptz not null default now()
);
create index if not exists hot_events_entry on hot_events (hot_list_entry_id, at desc);

-- Soft Code 1 (hot-list sighting) notifications in CommandMAPS.
create table if not exists alerts (
  id              text primary key,                 -- the acknowledgement event id
  type            text not null default 'hot_list_sighting',
  plate           text not null,
  hot_list_entry_id text not null,
  scan_id         text,
  risk_level      text,
  officer_number  text not null,
  device_key_id   text,
  lat             double precision,
  lng             double precision,
  accuracy_m      double precision,
  raised_at       timestamptz not null,
  received_at     timestamptz not null default now(),
  recipients      jsonb not null,
  status          text not null default 'active' check (status in ('active', 'closed')),
  closed_at       timestamptz,
  updated_at      timestamptz not null default now(),
  data            jsonb not null
);
create index if not exists alerts_active on alerts (status, raised_at desc);

create table if not exists alert_acks (
  alert_id        text not null references alerts (id),
  recipient       text not null,
  acknowledged_by text not null,
  acknowledged_at timestamptz not null default now(),
  primary key (alert_id, recipient)
);

create table if not exists infringements (
  number           text primary key,
  key_id           text not null references devices (key_id),
  scan_id          text not null,
  officer_number   text not null,
  status           text not null check (status in ('allocated', 'issued', 'cancelled', 'void_requested', 'voided', 'paid')),
  handoff_id       text,
  plate            text,
  offence_code     text check (offence_code in ('701', '702')),
  internal_variant text check (internal_variant in ('no_payment', 'expired_session', 'unknown')),
  variant_source   text,
  shortfall_minutes integer,
  time_from        timestamptz,
  time_to          timestamptz,
  issued_at        timestamptz,
  location         jsonb,
  record           jsonb,
  reissue_of       text references infringements (number),
  reissued_by      text references infringements (number),
  void_request     jsonb,
  paid_at          timestamptz,
  allocated_at     timestamptz not null,
  updated_at       timestamptz not null default now()
);
create index if not exists infringements_status on infringements (status, updated_at desc);
create index if not exists infringements_updated on infringements (key_id, updated_at);

create table if not exists infringement_events (
  id              bigserial primary key,
  number          text not null references infringements (number),
  at              timestamptz not null default now(),
  actor           text not null,
  actor_role      text not null,
  action          text not null,
  from_status     text,
  to_status       text,
  reason          text,
  data            jsonb
);
create index if not exists infringement_events_number on infringement_events (number, id);

-- Test payment provider: paid sessions testers create in the console (EasyPark / PayStay stand-in).
create table if not exists paid_sessions (
  id              bigserial primary key,
  plate_key       text not null,
  source          text not null check (source in ('easypark', 'paystay', 'meter', 'ticket', 'other')),
  source_ref      text not null default '',
  paid_from       timestamptz not null,
  paid_to         timestamptz not null,
  created_by      text not null,
  created_at      timestamptz not null default now()
);
create index if not exists paid_sessions_plate on paid_sessions (plate_key, paid_to desc);

create table if not exists audit_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  actor           text not null,
  role            text not null,
  action          text not null,
  entity          text not null,
  entity_id       text not null,
  data            jsonb
);

-- Change feed for devices: bumped whenever a row a device cares about changes.
create sequence if not exists change_seq;
alter table infringements add column if not exists change_no bigint not null default nextval('change_seq');
alter table alerts add column if not exists change_no bigint not null default nextval('change_seq');
create index if not exists infringements_change on infringements (key_id, change_no);
create index if not exists alerts_change on alerts (device_key_id, change_no);
