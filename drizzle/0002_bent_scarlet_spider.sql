CREATE TABLE `session_events` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`timestamp` integer NOT NULL,
	`selector` text,
	`duration_ms` integer,
	`scroll_percent` integer,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
