CREATE TABLE agent_skills (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  guide_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  entry_path TEXT,
  guide_version_id TEXT NOT NULL REFERENCES experience_versions(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  metadata TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  index_state TEXT NOT NULL CHECK(index_state IN ('pending', 'ready', 'failed')),
  embedding_key TEXT,
  embedding TEXT,
  lease_until INTEGER,
  lease_id TEXT,
  index_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_skills_guide_idx ON agent_skills(guide_id);
--> statement-breakpoint
CREATE INDEX agent_skills_site_idx ON agent_skills(org_id, site_id, enabled);
--> statement-breakpoint
CREATE INDEX agent_skills_pending_idx ON agent_skills(index_state, lease_until);
--> statement-breakpoint
ALTER TABLE geo_agent_turns ADD skill_diagnostics TEXT;
