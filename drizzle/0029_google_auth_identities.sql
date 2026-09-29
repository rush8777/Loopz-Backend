CREATE TABLE `__new_users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `password_hash` text,
  `name` text,
  `created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users` (`id`, `email`, `password_hash`, `name`, `created_at`)
SELECT `id`, `email`, `password_hash`, `name`, `created_at` FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE TABLE `user_auth_identities` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `provider` text NOT NULL,
  `provider_subject` text NOT NULL,
  `provider_email` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_auth_identities_provider_subject_uidx`
ON `user_auth_identities` (`provider`, `provider_subject`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_auth_identities_user_provider_uidx`
ON `user_auth_identities` (`user_id`, `provider`);
