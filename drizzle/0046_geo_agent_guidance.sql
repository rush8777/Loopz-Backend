CREATE TABLE geo_agent_guidance (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES geo_agent_conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES geo_agent_turns(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  widget_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  skill_revision TEXT NOT NULL,
  guide_id TEXT NOT NULL,
  guide_version_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted','started','waiting','completed','cancelled','failed','expired')),
  step_id TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  advances INTEGER NOT NULL DEFAULT 0,
  recoveries INTEGER NOT NULL DEFAULT 0,
  failure TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  started_at INTEGER,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX geo_guidance_turn_uidx ON geo_agent_guidance(turn_id);
--> statement-breakpoint
CREATE UNIQUE INDEX geo_guidance_owner_active_uidx ON geo_agent_guidance(site_id, owner)
  WHERE state IN ('accepted','started','waiting');
--> statement-breakpoint
CREATE INDEX geo_guidance_conversation_idx ON geo_agent_guidance(conversation_id, updated_at);
--> statement-breakpoint
CREATE INDEX geo_guidance_widget_idx ON geo_agent_guidance(site_id, widget_id);
--> statement-breakpoint
ALTER TABLE geo_agent_conversations ADD COLUMN guidance_revoked_at INTEGER;
