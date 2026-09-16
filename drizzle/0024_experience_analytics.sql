CREATE TABLE `experience_events` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `experience_id` text NOT NULL REFERENCES `experiences`(`id`) ON DELETE cascade,
  `version_id` text NOT NULL REFERENCES `experience_versions`(`id`) ON DELETE cascade,
  `impression_id` text REFERENCES `experience_impressions`(`id`) ON DELETE cascade,
  `event_type` text NOT NULL,
  `step_id` text,
  `step_index` integer,
  `anonymous_id` text,
  `tracked_user_id` text REFERENCES `tracked_users`(`id`) ON DELETE set null,
  `session_id` text,
  `page_view_id` text,
  `duration_ms` integer,
  `action` text,
  `timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `experience_events_site_time_idx` ON `experience_events` (`site_id`,`timestamp`);
--> statement-breakpoint
CREATE INDEX `experience_events_experience_time_idx` ON `experience_events` (`site_id`,`experience_id`,`timestamp`);
--> statement-breakpoint
CREATE INDEX `experience_events_impression_type_step_idx` ON `experience_events` (`impression_id`,`event_type`,`step_id`);
