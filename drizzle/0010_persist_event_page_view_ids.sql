ALTER TABLE `session_events` ADD `event_id` text;--> statement-breakpoint
ALTER TABLE `session_events` ADD `page_view_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `session_events_site_event_unique` ON `session_events` (`site_id`,`event_id`);
