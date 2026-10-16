ALTER TABLE `experiences` ADD `builder_mode` text DEFAULT 'grapesjs' NOT NULL;
--> statement-breakpoint
ALTER TABLE `experience_versions` ADD `revision` integer DEFAULT 1 NOT NULL;
