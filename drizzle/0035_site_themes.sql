CREATE TABLE `site_themes` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`active_tokens` text,
	`active_updated_at` integer,
	`candidate_tokens` text,
	`candidate_capture_id` text,
	`candidate_evidence` text,
	`candidate_origin` text,
	`candidate_captured_at` integer,
	`updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_themes_site_id_unique` ON `site_themes` (`site_id`);--> statement-breakpoint
CREATE TABLE `theme_capture_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_at` integer,
	`error_code` text,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `theme_capture_requests_site_created_idx` ON `theme_capture_requests` (`site_id`,`created_at`);
