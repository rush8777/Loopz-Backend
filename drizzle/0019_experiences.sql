CREATE TABLE `experiences` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `kind` text NOT NULL CHECK (`kind` IN ('guide','widget')),
  `widget_type` text CHECK (`widget_type` IS NULL OR `widget_type` IN ('anchored_card','toast','cursor_follow')),
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
CREATE INDEX `experiences_site_kind_status_idx` ON `experiences` (`site_id`,`kind`,`status`);
--> statement-breakpoint
CREATE TABLE `experience_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `experience_id` text NOT NULL REFERENCES `experiences`(`id`) ON DELETE cascade,
  `version_number` integer NOT NULL,
  `state` text NOT NULL DEFAULT 'draft' CHECK (`state` IN ('draft','published')),
  `definition` text NOT NULL,
  `created_by` text NOT NULL REFERENCES `users`(`id`),
  `created_at` integer NOT NULL DEFAULT (unixepoch('now') * 1000),
  `published_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experience_versions_experience_number_uidx` ON `experience_versions` (`experience_id`,`version_number`);
--> statement-breakpoint
CREATE INDEX `experience_versions_experience_state_idx` ON `experience_versions` (`experience_id`,`state`);
--> statement-breakpoint
CREATE TABLE `experience_impressions` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `experience_id` text NOT NULL REFERENCES `experiences`(`id`) ON DELETE cascade,
  `version_id` text NOT NULL REFERENCES `experience_versions`(`id`) ON DELETE cascade,
  `anonymous_id` text,
  `tracked_user_id` text REFERENCES `tracked_users`(`id`) ON DELETE set null,
  `session_id` text,
  `page_view_id` text,
  `shown_at` integer NOT NULL,
  `dismissed_at` integer,
  `completed_at` integer,
  `metadata` text
);
--> statement-breakpoint
CREATE INDEX `experience_impressions_lookup_idx` ON `experience_impressions` (`site_id`,`experience_id`,`anonymous_id`,`session_id`);
--> statement-breakpoint
CREATE TABLE `experience_editor_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `experience_id` text NOT NULL REFERENCES `experiences`(`id`) ON DELETE cascade,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `dashboard_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
  `token_hash` text NOT NULL UNIQUE,
  `allowed_origin` text NOT NULL,
  `expires_at` integer NOT NULL,
  `used_at` integer,
  `revoked_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch('now') * 1000)
);
--> statement-breakpoint
CREATE INDEX `experience_editor_sessions_experience_idx` ON `experience_editor_sessions` (`experience_id`);

