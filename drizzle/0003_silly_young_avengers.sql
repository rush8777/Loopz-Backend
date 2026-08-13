CREATE TABLE `session_replay_events` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`rrweb_type` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `session_events` ADD `x` integer;--> statement-breakpoint
ALTER TABLE `session_events` ADD `y` integer;--> statement-breakpoint
ALTER TABLE `session_events` ADD `viewport_width` integer;--> statement-breakpoint
ALTER TABLE `session_events` ADD `viewport_height` integer;