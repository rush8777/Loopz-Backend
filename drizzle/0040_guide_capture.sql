CREATE TABLE `guide_capture_checkpoints` (
  `experience_id` text PRIMARY KEY NOT NULL REFERENCES `experiences`(`id`) ON DELETE cascade,
  `editor_session_id` text REFERENCES `experience_editor_sessions`(`id`) ON DELETE set null,
  `revision` integer DEFAULT 0 NOT NULL,
  `checkpoint` text NOT NULL
);
