CREATE TABLE `experiences_new` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `kind` text NOT NULL CHECK (`kind` IN ('guide','widget')),
  `widget_type` text CHECK (`widget_type` IS NULL OR `widget_type` IN ('anchored_card','toast','cursor_follow','modal','slideout','hotspot','banner','survey')),
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
--> statement-breakpoint
CREATE TABLE `survey_responses` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `experience_id` text NOT NULL REFERENCES `experiences`(`id`) ON DELETE cascade,
  `version_id` text NOT NULL REFERENCES `experience_versions`(`id`) ON DELETE cascade,
  `impression_id` text NOT NULL REFERENCES `experience_impressions`(`id`) ON DELETE cascade,
  `anonymous_id` text NOT NULL,
  `tracked_user_id` text REFERENCES `tracked_users`(`id`) ON DELETE set null,
  `session_id` text NOT NULL,
  `current_step_id` text,
  `answers` text NOT NULL,
  `started_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `submitted_at` integer,
  `abandoned_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `survey_responses_impression_uidx` ON `survey_responses` (`impression_id`);
--> statement-breakpoint
CREATE INDEX `survey_responses_experience_idx` ON `survey_responses` (`site_id`,`experience_id`,`started_at`);
