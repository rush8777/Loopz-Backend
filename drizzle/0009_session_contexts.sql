CREATE TABLE `session_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`session_id` text NOT NULL,
	`anonymous_id` text NOT NULL,
	`browser_name` text,
	`browser_version` text,
	`os_name` text,
	`os_version` text,
	`device_type` text,
	`language` text,
	`timezone` text,
	`screen_width` integer,
	`screen_height` integer,
	`referrer` text,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `session_contexts_site_session_unique` ON `session_contexts` (`site_id`,`session_id`);
