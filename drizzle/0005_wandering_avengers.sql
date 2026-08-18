CREATE TABLE `pattern_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`representative_sequence` text NOT NULL,
	`occurrence_count` integer NOT NULL,
	`unique_session_count` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`similarity` text NOT NULL,
	`quality` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pattern_episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern_candidate_id` text NOT NULL,
	`episode_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`pattern_candidate_id`) REFERENCES `pattern_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
