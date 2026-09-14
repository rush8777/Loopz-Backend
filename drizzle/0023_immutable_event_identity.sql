ALTER TABLE `session_events` ADD `tracked_user_id` text REFERENCES `tracked_users`(`id`) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `session_events_site_tracked_user_ts_idx` ON `session_events` (`site_id`,`tracked_user_id`,`timestamp`);
