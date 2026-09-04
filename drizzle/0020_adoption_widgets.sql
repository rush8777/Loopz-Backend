CREATE TABLE `experiences_new` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `kind` text NOT NULL CHECK (`kind` IN ('guide','widget')),
  `widget_type` text CHECK (`widget_type` IS NULL OR `widget_type` IN ('anchored_card','toast','cursor_follow','modal','slideout','hotspot','banner')),
  `name` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','published','paused','archived')),
  `build_page_id` text REFERENCES `page_definitions`(`id`) ON DELETE set null,
  `build_url` text,
  `published_version_id` text,
  `created_by` text NOT NULL REFERENCES `users`(`id`),
  `created_at` integer NOT NULL DEFAULT (unixepoch('now') * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch('now') * 1000)
);
--> statement-breakpoint
INSERT INTO `experiences_new` (`id`,`site_id`,`kind`,`widget_type`,`name`,`status`,`build_page_id`,`build_url`,`published_version_id`,`created_by`,`created_at`,`updated_at`)
SELECT `id`,`site_id`,`kind`,`widget_type`,`name`,`status`,`build_page_id`,`build_url`,`published_version_id`,`created_by`,`created_at`,`updated_at` FROM `experiences`;
--> statement-breakpoint
DROP TABLE `experiences`;
--> statement-breakpoint
ALTER TABLE `experiences_new` RENAME TO `experiences`;
--> statement-breakpoint
CREATE INDEX `experiences_site_kind_status_idx` ON `experiences` (`site_id`,`kind`,`status`);
