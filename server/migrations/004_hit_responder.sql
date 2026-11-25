-- The officer who answered the hot-list pop-up (SAFE & CLEAR or CODE 1). A hit reported before
-- the officer number was known is recorded as "unknown" and takes the responder's number.
alter table hot_hits add column if not exists responded_by text;
