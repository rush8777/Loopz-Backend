-- Keep the strongest membership when older development databases contain
-- duplicate (user, organization) rows. For equal roles, keep the oldest row.
DELETE FROM `memberships`
WHERE EXISTS (
  SELECT 1
  FROM `memberships` AS `candidate`
  WHERE `candidate`.`user_id` = `memberships`.`user_id`
    AND `candidate`.`org_id` = `memberships`.`org_id`
    AND (
      CASE `candidate`.`role`
        WHEN 'OWNER' THEN 4
        WHEN 'ADMIN' THEN 3
        WHEN 'MEMBER' THEN 2
        WHEN 'VIEWER' THEN 1
        ELSE 0
      END
      >
      CASE `memberships`.`role`
        WHEN 'OWNER' THEN 4
        WHEN 'ADMIN' THEN 3
        WHEN 'MEMBER' THEN 2
        WHEN 'VIEWER' THEN 1
        ELSE 0
      END
      OR (
        `candidate`.`role` = `memberships`.`role`
        AND `candidate`.`rowid` < `memberships`.`rowid`
      )
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_org_uidx` ON `memberships` (`user_id`,`org_id`);
--> statement-breakpoint
CREATE TABLE `organization_invitations` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `email` text NOT NULL,
  `role` text NOT NULL,
  `token_hash` text NOT NULL,
  `invited_by_user_id` text NOT NULL,
  `expires_at` integer NOT NULL,
  `accepted_at` integer,
  `revoked_at` integer,
  `created_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch('now') * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_token_hash_unique` ON `organization_invitations` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `organization_invitations_org_email_idx` ON `organization_invitations` (`org_id`,`email`);
--> statement-breakpoint
CREATE INDEX `organization_invitations_org_created_idx` ON `organization_invitations` (`org_id`,`created_at`);
