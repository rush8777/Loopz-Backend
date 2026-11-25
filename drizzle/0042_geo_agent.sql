-- SQLite expands the widget type check by rebuilding the table in the migration transaction.
-- Roll back rather than accept any foreign-key cascades or mismatched row counts.
CREATE TABLE _geo_agent_upgrade_guard (
  experiences_count integer NOT NULL,
  experience_versions_count integer NOT NULL,
  experience_impressions_count integer NOT NULL,
  experience_editor_sessions_count integer NOT NULL,
  experience_events_count integer NOT NULL,
  survey_responses_count integer NOT NULL,
  guide_capture_checkpoints_count integer NOT NULL,
  checklist_states_count integer NOT NULL,
  checklist_item_completions_count integer NOT NULL,
  verified integer NOT NULL DEFAULT 1 CHECK (verified = 1)
);
--> statement-breakpoint
INSERT INTO _geo_agent_upgrade_guard VALUES ((SELECT count(*) FROM experiences), (SELECT count(*) FROM experience_versions), (SELECT count(*) FROM experience_impressions), (SELECT count(*) FROM experience_editor_sessions), (SELECT count(*) FROM experience_events), (SELECT count(*) FROM survey_responses), (SELECT count(*) FROM guide_capture_checkpoints), (SELECT count(*) FROM checklist_states), (SELECT count(*) FROM checklist_item_completions), 1);
--> statement-breakpoint
CREATE TABLE `experiences_new` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `kind` text NOT NULL CHECK (`kind` IN ('guide','widget','checklist')),
  `widget_type` text CHECK (`widget_type` IS NULL OR `widget_type` IN ('anchored_card','toast','cursor_follow','modal','slideout','hotspot','banner','survey','geo_agent')),
  `name` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','published','paused','archived')),
  `build_page_id` text REFERENCES `page_definitions`(`id`) ON DELETE set null,
  `build_url` text,
  `published_version_id` text,
  `created_by` text NOT NULL REFERENCES `users`(`id`),
  `created_at` integer NOT NULL DEFAULT (unixepoch('now') * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch('now') * 1000),
  `launch_setup_completed_at` integer,
  `builder_mode` text NOT NULL DEFAULT 'grapesjs'
);
--> statement-breakpoint
INSERT INTO `experiences_new` (`id`, `site_id`, `kind`, `widget_type`, `name`, `status`, `build_page_id`, `build_url`, `published_version_id`, `created_by`, `created_at`, `updated_at`, `launch_setup_completed_at`, `builder_mode`)
SELECT `id`, `site_id`, `kind`, `widget_type`, `name`, `status`, `build_page_id`, `build_url`, `published_version_id`, `created_by`, `created_at`, `updated_at`, `launch_setup_completed_at`, `builder_mode` FROM `experiences`;
--> statement-breakpoint
DROP TABLE `experiences`;
--> statement-breakpoint
ALTER TABLE `experiences_new` RENAME TO `experiences`;
--> statement-breakpoint
CREATE INDEX `experiences_site_kind_status_idx` ON `experiences` (`site_id`, `kind`, `status`);
--> statement-breakpoint
UPDATE _geo_agent_upgrade_guard
SET verified = (
  (SELECT count(*) FROM experiences) = experiences_count AND
  (SELECT count(*) FROM experience_versions) = experience_versions_count AND
  (SELECT count(*) FROM experience_impressions) = experience_impressions_count AND
  (SELECT count(*) FROM experience_editor_sessions) = experience_editor_sessions_count AND
  (SELECT count(*) FROM experience_events) = experience_events_count AND
  (SELECT count(*) FROM survey_responses) = survey_responses_count AND
  (SELECT count(*) FROM guide_capture_checkpoints) = guide_capture_checkpoints_count AND
  (SELECT count(*) FROM checklist_states) = checklist_states_count AND
  (SELECT count(*) FROM checklist_item_completions) = checklist_item_completions_count
);
--> statement-breakpoint
DROP TABLE _geo_agent_upgrade_guard;
--> statement-breakpoint
CREATE TABLE `geo_agent_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`experience_id` text NOT NULL,
	`version_id` text NOT NULL,
	`owner` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`experience_id`) REFERENCES `experiences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `experience_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `geo_agent_conversations_owner_idx` ON `geo_agent_conversations` (`site_id`,`experience_id`,`owner`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `geo_agent_conversations_expiry_idx` ON `geo_agent_conversations` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `geo_agent_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`site_id` text NOT NULL,
	`request_id` text NOT NULL,
	`question` text NOT NULL,
	`status` text NOT NULL,
	`answer` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`reserved_tokens` integer NOT NULL,
	`used_tokens` integer DEFAULT 0 NOT NULL,
	`retrieved_count` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`first_delta_ms` integer,
	`provider` text,
	`model` text,
	`feedback` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `geo_agent_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `geo_agent_turns_request_idx` ON `geo_agent_turns` (`conversation_id`,`request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `geo_agent_turns_active_idx` ON `geo_agent_turns` (`conversation_id`) WHERE "geo_agent_turns"."status" = 'running';
--> statement-breakpoint
CREATE INDEX `geo_agent_turns_site_created_idx` ON `geo_agent_turns` (`site_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `geo_agent_usage` (
	`site_id` text NOT NULL,
	`day` text NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `geo_agent_usage_site_day_idx` ON `geo_agent_usage` (`site_id`,`day`);
