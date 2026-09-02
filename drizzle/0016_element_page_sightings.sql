CREATE TABLE `element_page_sightings` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`element_id` text NOT NULL,
	`page_path` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`element_id`) REFERENCES `element_catalog`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `element_page_sightings_site_element_path_uidx` ON `element_page_sightings` (`site_id`,`element_id`,`page_path`);
--> statement-breakpoint
CREATE INDEX `element_page_sightings_site_path_idx` ON `element_page_sightings` (`site_id`,`page_path`);
