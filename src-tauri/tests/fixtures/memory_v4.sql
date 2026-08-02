-- Independent historical v4 fixture with linked memories and a checkpoint.
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
INSERT INTO schema_migrations(version, applied_at) VALUES
    (1, 1700000000000),
    (2, 1700000000100),
    (3, 1700000000200),
    (4, 1700000000300);

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

CREATE VIRTUAL TABLE memory_fts USING fts5(
    memory_id UNINDEXED,
    workspace_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61'
);
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories
WHEN new.deleted_at IS NULL BEGIN
    INSERT INTO memory_fts(memory_id, workspace_id, title, body)
    VALUES (new.id, new.workspace_id, new.title, new.body);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
    DELETE FROM memory_fts WHERE memory_id = old.id;
    INSERT INTO memory_fts(memory_id, workspace_id, title, body)
    SELECT new.id, new.workspace_id, new.title, new.body
    WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
    DELETE FROM memory_fts WHERE memory_id = old.id;
END;

CREATE TABLE memory_links (
    source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(source_id, target_id, relation),
    CHECK(source_id <> target_id)
);
CREATE INDEX memory_links_target_idx ON memory_links(target_id);

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
CREATE INDEX checkpoints_workspace_created_idx
    ON checkpoints(workspace_id, created_at DESC);
CREATE VIRTUAL TABLE checkpoint_fts USING fts5(
    checkpoint_id UNINDEXED,
    workspace_id UNINDEXED,
    summary,
    tokenize = 'unicode61'
);
CREATE TRIGGER checkpoints_fts_insert AFTER INSERT ON checkpoints BEGIN
    INSERT INTO checkpoint_fts(checkpoint_id, workspace_id, summary)
    VALUES (new.id, new.workspace_id, new.summary);
END;
CREATE TRIGGER checkpoints_fts_delete AFTER DELETE ON checkpoints BEGIN
    DELETE FROM checkpoint_fts WHERE checkpoint_id = old.id;
END;

INSERT INTO workspaces(
    id, canonical_root, display_name, color, created_at, updated_at
) VALUES (
    'ws_legacy', '__WORKSPACE_ROOT__', 'Legacy KödMem', 'mauve',
    1700000000000, 1700000003000
);
INSERT INTO memories(
    id, workspace_id, kind, title, body, source, source_client, session_id,
    pinned, version, idempotency_key, created_at, updated_at, deleted_at
) VALUES
    (
        'mem_legacy_decision', 'ws_legacy', 'decision', 'Legacy WAL decision',
        'legacywal keeps desktop and agent writers on one local database.',
        'user', 'legacy-ui', NULL, 1, 2, 'legacy-decision',
        1700000001000, 1700000003000, NULL
    ),
    (
        'mem_legacy_task', 'ws_legacy', 'task', 'Legacy migration task',
        'Verify search, links, and checkpoints after upgrading the database.',
        'agent', 'legacy-agent', 'legacy-session', 0, 1, 'legacy-task',
        1700000002000, 1700000002000, NULL
    );
INSERT INTO memory_links(source_id, target_id, relation, created_at)
VALUES ('mem_legacy_decision', 'mem_legacy_task', 'drives', 1700000002500);
INSERT INTO checkpoints(
    id, workspace_id, summary, decisions_json, next_actions_json,
    changed_paths_json, source, source_client, session_id,
    idempotency_key, created_at
) VALUES (
    'cp_legacy', 'ws_legacy', 'Legacy checkpoint handoff',
    '["Keep SQLite local"]', '["Upgrade the fixture"]',
    '["src-tauri/src/memory.rs"]', 'agent', 'legacy-agent',
    'legacy-session', 'legacy-checkpoint', 1700000004000
);
