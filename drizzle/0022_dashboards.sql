CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dashboards_site_updated_idx` ON `dashboards` (`site_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `dashboard_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`dashboard_id` text NOT NULL,
	`title` text NOT NULL,
	`card_type` text NOT NULL,
	`position` integer NOT NULL,
	`width` text DEFAULT 'medium' NOT NULL,
	`configuration` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dashboard_cards_dashboard_position_idx` ON `dashboard_cards` (`dashboard_id`,`position`);
--> statement-breakpoint
CREATE INDEX `session_events_site_timestamp_idx` ON `session_events` (`site_id`,`timestamp`);
--> statement-breakpoint
CREATE INDEX `session_events_site_session_timestamp_idx` ON `session_events` (`site_id`,`session_id`,`timestamp`);
