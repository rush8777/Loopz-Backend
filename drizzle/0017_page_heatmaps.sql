ALTER TABLE `page_definitions` ADD `heatmap_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `session_events` ADD `document_x` integer;
--> statement-breakpoint
ALTER TABLE `session_events` ADD `document_y` integer;
--> statement-breakpoint
ALTER TABLE `session_events` ADD `document_width` integer;
--> statement-breakpoint
ALTER TABLE `session_events` ADD `document_height` integer;
--> statement-breakpoint
ALTER TABLE `session_events` ADD `device_class` text;
--> statement-breakpoint
ALTER TABLE `session_events` ADD `heatmap_state_id` text;
--> statement-breakpoint
CREATE TABLE `page_heatmap_states` (`id` text PRIMARY KEY NOT NULL, `site_id` text NOT NULL, `page_definition_id` text NOT NULL, `name` text NOT NULL, `selector` text NOT NULL, `created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL, FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE cascade, FOREIGN KEY (`page_definition_id`) REFERENCES `page_definitions`(`id`) ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `page_heatmap_states_site_page_idx` ON `page_heatmap_states` (`site_id`,`page_definition_id`);
--> statement-breakpoint
CREATE TABLE `heatmap_reference_snapshots` (`id` text PRIMARY KEY NOT NULL, `site_id` text NOT NULL, `page_definition_id` text NOT NULL, `page_state_id` text, `page_path` text NOT NULL, `device_class` text NOT NULL, `viewport_width` integer NOT NULL, `viewport_height` integer NOT NULL, `document_width` integer NOT NULL, `document_height` integer NOT NULL, `image_data_url` text NOT NULL, `captured_at` integer NOT NULL, FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE cascade, FOREIGN KEY (`page_definition_id`) REFERENCES `page_definitions`(`id`) ON DELETE cascade, FOREIGN KEY (`page_state_id`) REFERENCES `page_heatmap_states`(`id`) ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `heatmap_snapshots_page_state_device_idx` ON `heatmap_reference_snapshots` (`page_definition_id`,`page_state_id`,`device_class`);
--> statement-breakpoint
CREATE TABLE `heatmap_capture_requests` (`id` text PRIMARY KEY NOT NULL, `token` text NOT NULL UNIQUE, `site_id` text NOT NULL, `page_definition_id` text NOT NULL, `page_state_id` text, `device_class` text NOT NULL, `expires_at` integer NOT NULL, `used_at` integer, `created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL, FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE cascade, FOREIGN KEY (`page_definition_id`) REFERENCES `page_definitions`(`id`) ON DELETE cascade, FOREIGN KEY (`page_state_id`) REFERENCES `page_heatmap_states`(`id`) ON DELETE cascade);
