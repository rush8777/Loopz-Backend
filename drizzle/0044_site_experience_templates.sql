CREATE TABLE site_experience_templates (
  id TEXT PRIMARY KEY NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  layout TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX site_experience_templates_name_idx ON site_experience_templates(site_id, name);
