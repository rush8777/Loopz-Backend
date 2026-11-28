ALTER TABLE `theme_capture_requests` ADD `explicit_only` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `theme_capture_requests` ADD `design_evidence` text;
--> statement-breakpoint
ALTER TABLE `theme_capture_requests` ADD `design_job` text;
--> statement-breakpoint
ALTER TABLE `site_style_presets` ADD `source_capture_id` text REFERENCES `theme_capture_requests`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `site_style_presets` ADD `source_design` text;
