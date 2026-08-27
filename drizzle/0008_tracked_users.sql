ALTER TABLE `session_events` ADD `anonymous_id` text;--> statement-breakpoint
ALTER TABLE `session_events` ADD `page_path` text;--> statement-breakpoint
CREATE TABLE `tracked_users` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`external_user_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`first_identified_at` integer NOT NULL,
	`last_identified_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_users_site_external_unique` ON `tracked_users` (`site_id`,`external_user_id`);--> statement-breakpoint
CREATE TABLE `tracked_user_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`tracked_user_id` text NOT NULL,
	`anonymous_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracked_user_id`) REFERENCES `tracked_users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_user_aliases_site_anon_unique` ON `tracked_user_aliases` (`site_id`,`anonymous_id`);--> statement-breakpoint
CREATE TABLE `tracked_user_properties` (
	`id` text PRIMARY KEY NOT NULL,
	`tracked_user_id` text NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`value_type` text NOT NULL,
	`source` text DEFAULT 'identify' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`tracked_user_id`) REFERENCES `tracked_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_user_properties_user_name_unique` ON `tracked_user_properties` (`tracked_user_id`,`name`);
