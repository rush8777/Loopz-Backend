CREATE TABLE `knowledge_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`position` integer NOT NULL,
	`heading` text,
	`content` text NOT NULL,
	`embedding` text,
	FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_chunks_document_position_idx` ON `knowledge_chunks` (`document_id`,`position`);
--> statement-breakpoint
CREATE TABLE `knowledge_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`revision` text NOT NULL,
	`document_key` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_documents_revision_key_idx` ON `knowledge_documents` (`source_id`,`revision`,`document_key`);
--> statement-breakpoint
CREATE INDEX `knowledge_documents_revision_hash_idx` ON `knowledge_documents` (`source_id`,`revision`,`content_hash`);
--> statement-breakpoint
CREATE TABLE `knowledge_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`active_revision` text,
	`embedding_key` text,
	`sync_hours` integer,
	`next_sync_at` integer,
	`last_synced_at` integer,
	`excluded_keys` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_sources_scope_idx` ON `knowledge_sources` (`org_id`,`site_id`);
--> statement-breakpoint
CREATE INDEX `knowledge_sources_schedule_idx` ON `knowledge_sources` (`enabled`,`next_sync_at`);
--> statement-breakpoint
CREATE TABLE `knowledge_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_at` integer NOT NULL,
	`lease_until` integer,
	`lease_owner` text,
	`completed` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`embedding_tokens` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_sync_jobs_active_idx` ON `knowledge_sync_jobs` (`source_id`) WHERE "knowledge_sync_jobs"."status" IN ('queued', 'processing');
--> statement-breakpoint
CREATE INDEX `knowledge_sync_jobs_claim_idx` ON `knowledge_sync_jobs` (`status`,`run_at`,`lease_until`);
--> statement-breakpoint
CREATE INDEX `knowledge_sync_jobs_source_created_idx` ON `knowledge_sync_jobs` (`source_id`,`created_at`);
