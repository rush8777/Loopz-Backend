ALTER TABLE `session_events` ADD `origin` text;
--> statement-breakpoint
CREATE INDEX `session_events_site_origin_user_ts_idx`
ON `session_events` (`site_id`, `origin`, `tracked_user_id`, `timestamp`);
