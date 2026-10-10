-- How a refresh URL's last call ENDED (src/server/hooks/): a pipeline that
-- POSTed the URL can GET it and wait for the refresh, then fail its own run
-- when the refresh failed.
--
-- `last_result`, written by the pod that handled the call, so any pod can
-- answer for it:
--
--   running          the call queued refreshes and they have not all landed
--   ok               everything it started has landed (`last_finished_at`)
--   failed           a refresh it started failed, or the call was refused
--   already_running  a refresh was already running and the call joined it:
--                    call again for a refresh that begins now
--   NULL             no call's outcome was ever recorded — never called, or
--                    called by a release that kept none
--
-- Additive: two nullable columns an older release neither reads nor writes.
ALTER TABLE refresh_hooks ADD COLUMN last_result text CHECK (last_result IN ('running', 'ok', 'failed', 'already_running'));
ALTER TABLE refresh_hooks ADD COLUMN last_finished_at timestamptz;
