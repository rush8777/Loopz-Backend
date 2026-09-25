CREATE TABLE `sdk_verification_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`acknowledged_at` integer,
	`created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sdk_verification_challenges_site_created_idx` ON `sdk_verification_challenges` (`site_id`,`created_at`);
