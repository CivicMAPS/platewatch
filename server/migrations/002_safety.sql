-- Hot-list officer-safety flow (owner direction 25/11/2026), replacing the 23/11 alert tables.
--   hit → officer acknowledges SAFE & CLEAR or CODE 1
--   no acknowledgement in time → soft Code 1 (amber) to dispatch + the officer's team supervisor
--     (supervisor not on shift → all team supervisors on shift + the compliance lead)
--   acknowledged → radio response requested → officer OK (resolved) or no response → Code 1
--   Code 1 (red) → all officers and staff of the branch: alarm + location pin; full life cycle.

drop table if exists alert_acks;
drop table if exists alerts;

create table if not exists staff (
  id              text primary key,                 -- staff number
  name            text not null,
  role            text not null check (role in ('officer', 'team_supervisor', 'dispatch', 'compliance_lead')),
  officer_number  text unique,                      -- handset officer number (officers, patrolling supervisors)
  team            text,
  branch          text not null default 'parking',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists shifts (
  staff_id        text not null references staff (id) on delete cascade,
  day             date not null,
  primary key (staff_id, day)
);

create table if not exists hot_hits (
  id                text primary key,               -- device-generated
  plate             text not null,
  plate_key         text not null,
  hot_list_entry_id text not null,
  scan_id           text,
  officer_number    text not null,
  device_key_id     text,
  lat               double precision,
  lng               double precision,
  accuracy_m        double precision,
  at                timestamptz not null,
  ack_deadline      timestamptz not null,
  response          text check (response in ('safe_clear', 'code1')),
  responded_at      timestamptz,
  note              text,
  entry             jsonb not null default '{}',    -- plate, make, type, colour, alert message, risk, owner description
  received_at       timestamptz not null default now()
);
create index if not exists hot_hits_plate on hot_hits (plate_key, at desc);
create index if not exists hot_hits_entry on hot_hits (hot_list_entry_id, at desc);
create index if not exists hot_hits_pending on hot_hits (ack_deadline) where response is null;

create table if not exists alerts (
  id                text primary key,
  kind              text not null check (kind in ('soft_code1', 'code1')),
  hit_id            text references hot_hits (id),
  escalated_from    text references alerts (id),
  cause             text not null,                  -- hot_list_timeout | hot_list_code1 | officer_duress | no_radio_response
  raised_by         text not null,                  -- handset | server_watchdog | officer | <staff id>
  officer_number    text not null,
  officer_name      text,
  team              text,
  branch            text not null,
  device_key_id     text,
  lat               double precision,
  lng               double precision,
  accuracy_m        double precision,
  location_at       timestamptz,
  raised_at         timestamptz not null,
  recipients        jsonb not null,                 -- { roles: [...], staffIds: [...], fallback: bool, branch }
  status            text not null check (status in ('active', 'radio_requested', 'resolved', 'escalated', 'acknowledged', 'cleared', 'cancelled')),
  acknowledged_by   text,
  acknowledged_at   timestamptz,
  closed_by         text,
  closed_at         timestamptz,
  outcome           text,
  escalated_to      text references alerts (id),
  data              jsonb not null default '{}',
  change_no         bigint not null default nextval('change_seq'),
  updated_at        timestamptz not null default now()
);
create index if not exists alerts_open on alerts (status, raised_at desc);
create index if not exists alerts_branch on alerts (branch, kind, status);
create index if not exists alerts_change on alerts (device_key_id, change_no);

create table if not exists alert_locations (
  id              bigserial primary key,
  alert_id        text not null references alerts (id),
  at              timestamptz not null,
  lat             double precision not null,
  lng             double precision not null,
  accuracy_m      double precision
);
create index if not exists alert_locations_alert on alert_locations (alert_id, at desc);

-- Officers' handsets that received (and silenced) a branch Code 1 alarm.
create table if not exists alert_receipts (
  alert_id        text not null references alerts (id),
  officer_number  text not null,
  at              timestamptz not null default now(),
  primary key (alert_id, officer_number)
);

create table if not exists alert_events (
  id              bigserial primary key,
  alert_id        text not null references alerts (id),
  at              timestamptz not null default now(),
  actor           text not null,
  role            text not null,
  action          text not null,
  note            text
);
create index if not exists alert_events_alert on alert_events (alert_id, id);

-- One soft Code 1 and one officer Code 1 per hit, whoever raises it first (handset or watchdog).
create unique index if not exists alerts_hit_kind on alerts (hit_id, kind) where hit_id is not null;
