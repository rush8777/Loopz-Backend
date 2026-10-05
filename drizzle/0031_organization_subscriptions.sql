CREATE TABLE `organization_subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `plan_id` text NOT NULL,
  `status` text NOT NULL,
  `trial_ends_at` integer,
  `current_period_starts_at` integer,
  `current_period_ends_at` integer,
  `paddle_customer_id` text,
  `paddle_subscription_id` text,
  `paddle_price_id` text,
  `paddle_updated_at` integer,
  `cancel_at_period_end` integer DEFAULT false NOT NULL,
  `created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_subscriptions_org_uidx` ON `organization_subscriptions` (`org_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_subscriptions_paddle_subscription_uidx` ON `organization_subscriptions` (`paddle_subscription_id`);
--> statement-breakpoint
CREATE TABLE `billing_webhook_events` (
  `event_id` text PRIMARY KEY NOT NULL,
  `event_type` text NOT NULL,
  `occurred_at` integer NOT NULL,
  `processed_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL
);
