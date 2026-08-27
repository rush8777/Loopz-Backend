CREATE TABLE `element_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`selector` text NOT NULL,
	`tag_name` text NOT NULL,
	`label` text,
	`role` text,
	`source` text DEFAULT 'crawl' NOT NULL,
	`is_ignored` integer DEFAULT false NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
