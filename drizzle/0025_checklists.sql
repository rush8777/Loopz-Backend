CREATE TABLE `experiences_new` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `kind` text NOT NULL CHECK (`kind` IN ('guide','widget','checklist')),
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
CREATE TABLE `checklist_states` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `experience_id` text NOT NULL REFERENCES `experiences`(`id`) ON DELETE cascade,
  `anonymous_id` text NOT NULL,
  `tracked_user_id` text REFERENCES `tracked_users`(`id`) ON DELETE cascade,
  `is_collapsed` integer NOT NULL DEFAULT 0,
  `started_at` integer,
  `last_shown_at` integer,
  `last_opened_at` integer,
  `dismissed_at` integer,
  `completed_at` integer,
  `completion_acknowledged_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch('now') * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch('now') * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checklist_states_identified_uidx` ON `checklist_states` (`site_id`,`experience_id`,`tracked_user_id`) WHERE `tracked_user_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `checklist_states_anonymous_uidx` ON `checklist_states` (`site_id`,`experience_id`,`anonymous_id`) WHERE `tracked_user_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `checklist_states_site_experience_idx` ON `checklist_states` (`site_id`,`experience_id`);
--> statement-breakpoint
CREATE TABLE `checklist_item_completions` (
  `id` text PRIMARY KEY NOT NULL,
  `checklist_state_id` text NOT NULL REFERENCES `checklist_states`(`id`) ON DELETE cascade,
  `item_id` text NOT NULL,
  `completed_at` integer NOT NULL,
  `completion_source` text NOT NULL,
  `completed_version_id` text REFERENCES `experience_versions`(`id`) ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checklist_item_completions_state_item_uidx` ON `checklist_item_completions` (`checklist_state_id`,`item_id`);
--> statement-breakpoint
ALTER TABLE `experience_events` ADD `item_id` text;
--> statement-breakpoint
ALTER TABLE `experience_events` ADD `item_index` integer;
--> statement-breakpoint
ALTER TABLE `experience_events` ADD `completion_source` text;
--> statement-breakpoint
CREATE INDEX `experience_events_experience_item_idx` ON `experience_events` (`experience_id`,`item_id`,`event_type`);
