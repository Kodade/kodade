-- Independent v6 fixture with equal-timestamp activity rows before sequences.
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
INSERT INTO schema_migrations(version, applied_at) VALUES
    (1, 1700000000000),
    (2, 1700000000100),
    (3, 1700000000200),
    (4, 1700000000300),
    (5, 1700000000400),
    (6, 1700000000500);

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
    created_at INTEGER NOT NULL,
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
);
CREATE INDEX activity_workspace_time_idx
    ON activity_events(workspace_id, occurred_at DESC);

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
CREATE INDEX audit_workspace_time_idx
    ON mcp_audit(workspace_id, occurred_at DESC);

INSERT INTO workspaces(
    id, canonical_root, display_name, color, created_at, updated_at
) VALUES (
    'ws_legacy', '__WORKSPACE_ROOT__', 'Legacy KödMem', 'mauve',
    1700000000000, 1700000003000
);
INSERT INTO activity_events(
    id, workspace_id, kind, source, session_id, relative_path, provider, occurred_at
) VALUES
    ('act_z_legacy_start', 'ws_legacy', 'session_started', 'legacy-ui', 'legacy-session', NULL, 'codex', 1700000005000),
    ('act_a_legacy_exit', 'ws_legacy', 'session_exited', 'legacy-ui', 'legacy-session', NULL, NULL, 1700000005000);
