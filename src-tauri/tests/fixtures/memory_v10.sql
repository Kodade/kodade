/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be disabled */
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
INSERT INTO schema_migrations VALUES(1,1700000000000);
INSERT INTO schema_migrations VALUES(2,1700000000100);
INSERT INTO schema_migrations VALUES(3,1700000000200);
INSERT INTO schema_migrations VALUES(4,1700000000300);
INSERT INTO schema_migrations VALUES(5,1700000000400);
INSERT INTO schema_migrations VALUES(6,1700000000500);
INSERT INTO schema_migrations VALUES(7,7);
INSERT INTO schema_migrations VALUES(8,8);
INSERT INTO schema_migrations VALUES(9,9);
INSERT INTO schema_migrations VALUES(10,10);
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    canonical_root TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    color TEXT,
    capture_paused INTEGER NOT NULL DEFAULT 0 CHECK (capture_paused IN (0, 1)),
    activity_retention_days INTEGER NOT NULL DEFAULT 30,
    audit_retention_days INTEGER NOT NULL DEFAULT 30,
    tombstone_retention_days INTEGER NOT NULL DEFAULT 30,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
INSERT INTO workspaces VALUES('ws_legacy','__WORKSPACE_ROOT__','Legacy KödMem','mauve',0,30,30,30,1700000000000,1700000003000);
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('summary', 'decision', 'task', 'fact', 'preference')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'kodade', 'agent')),
    source_client TEXT NOT NULL,
    session_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    UNIQUE(workspace_id, idempotency_key)
);
CREATE TABLE memory_links (
    source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(source_id, target_id, relation),
    CHECK(source_id <> target_id)
);
CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    decisions_json TEXT NOT NULL,
    next_actions_json TEXT NOT NULL,
    changed_paths_json TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'kodade', 'agent')),
    source_client TEXT NOT NULL,
    session_id TEXT,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL, updates_state INTEGER NOT NULL DEFAULT 1 CHECK (updates_state IN (0, 1)),
    UNIQUE(workspace_id, idempotency_key)
);
CREATE TABLE activity_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN (
        'project_opened', 'project_closed', 'session_started', 'session_exited',
        'active', 'idle', 'file_opened', 'file_saved', 'provider_launched'
    )),
    source TEXT NOT NULL,
    session_id TEXT,
    relative_path TEXT,
    provider TEXT,
    occurred_at INTEGER NOT NULL
, sequence INTEGER NOT NULL DEFAULT 0);
INSERT INTO activity_events VALUES('act_z_legacy_start','ws_legacy','session_started','legacy-ui','legacy-session',NULL,'codex',1700000005000,1);
INSERT INTO activity_events VALUES('act_a_legacy_exit','ws_legacy','session_exited','legacy-ui','legacy-session',NULL,NULL,1700000005000,2);
CREATE TABLE mcp_audit (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    client TEXT NOT NULL,
    capability TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT,
    result TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    session_id TEXT
);
CREATE TABLE activity_workspace_sequences (  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,  next_sequence INTEGER NOT NULL );
INSERT INTO activity_workspace_sequences VALUES('ws_legacy',2);
CREATE TABLE working_memory_config (  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,  mode TEXT NOT NULL CHECK (mode IN ('commit', 'local')),  activated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,  last_indexed_at INTEGER, last_commit TEXT );
CREATE TABLE working_memory_files (  id TEXT PRIMARY KEY,  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,  relative_path TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,  kind TEXT NOT NULL CHECK (kind IN ('summary', 'decision')),  updated_at INTEGER NOT NULL, UNIQUE(workspace_id, relative_path) );
PRAGMA writable_schema=ON;
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','working_memory_fts','working_memory_fts',0,'CREATE VIRTUAL TABLE working_memory_fts USING fts5(file_id UNINDEXED, workspace_id UNINDEXED, title, body, tokenize = ''unicode61'')');
CREATE TABLE IF NOT EXISTS 'working_memory_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO working_memory_fts_data VALUES(1,X'');
INSERT INTO working_memory_fts_data VALUES(10,X'00000000000000');
CREATE TABLE IF NOT EXISTS 'working_memory_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'working_memory_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3);
CREATE TABLE IF NOT EXISTS 'working_memory_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'working_memory_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO working_memory_fts_config VALUES('version',4);
CREATE TABLE projects_vault_config (  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), canonical_root TEXT NOT NULL,  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE TABLE logical_projects (  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE TABLE workspace_project_mappings (  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,  project_id TEXT NOT NULL REFERENCES logical_projects(id) ON DELETE RESTRICT,  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE TRIGGER working_memory_fts_insert AFTER INSERT ON working_memory_files BEGIN  INSERT INTO working_memory_fts(file_id, workspace_id, title, body) VALUES (new.id, new.workspace_id, new.title, new.body); END;
CREATE TRIGGER working_memory_fts_update AFTER UPDATE ON working_memory_files BEGIN  DELETE FROM working_memory_fts WHERE file_id = old.id;  INSERT INTO working_memory_fts(file_id, workspace_id, title, body) VALUES (new.id, new.workspace_id, new.title, new.body); END;
CREATE TRIGGER working_memory_fts_delete AFTER DELETE ON working_memory_files BEGIN  DELETE FROM working_memory_fts WHERE file_id = old.id; END;
CREATE INDEX activity_workspace_time_idx
    ON activity_events(workspace_id, occurred_at DESC);
CREATE INDEX audit_workspace_time_idx
    ON mcp_audit(workspace_id, occurred_at DESC);
CREATE UNIQUE INDEX activity_workspace_sequence_idx ON activity_events(workspace_id, sequence);
CREATE INDEX activity_workspace_time_sequence_idx ON activity_events(workspace_id, occurred_at DESC, sequence DESC);
CREATE INDEX working_memory_files_workspace_idx ON working_memory_files(workspace_id, updated_at DESC);
CREATE INDEX workspace_project_mappings_project_idx ON workspace_project_mappings(project_id, workspace_id);
PRAGMA writable_schema=OFF;
COMMIT;
