CREATE TABLE `pattern_match_states` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern_id` text NOT NULL,
	`session_id` text NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`matched_steps` text DEFAULT '[]' NOT NULL,
	`started_at` integer,
	`last_matched_at` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`pattern_id`) REFERENCES `patterns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pattern_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern_id` text NOT NULL,
	`site_id` text NOT NULL,
	`session_id` text NOT NULL,
	`matched_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`pattern_id`) REFERENCES `patterns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `patterns` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`origin` text DEFAULT 'AUTHORED' NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`match_window_ms` integer NOT NULL,
	`steps` text NOT NULL,
	`feedback` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
