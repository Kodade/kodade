use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{
    fts_query, now_millis, ActivityEvent, ActivityKind, Checkpoint, MemoryError, MemoryKind,
    MemoryQuery, MemorySearchHit, MemorySource, MemoryStore, NewCheckpoint, Page, Result,
    StoreAccess, Workspace,
};

const MEMORY_DIRECTORY: &str = ".kodade/memory";
const STATE_FILE: &str = "STATE.md";
const WORKLOG_FILE: &str = "WORKLOG.md";
const DECISIONS_FILE: &str = "decisions.md";
const IMPORTED_FILE: &str = "MEMORIES.md";
const LOCAL_GITIGNORE_START: &str = "# BEGIN KödMem local working memory";
const LOCAL_GITIGNORE_END: &str = "# END KödMem local working memory";
const LOCAL_GITIGNORE_BLOCK: &str =
    "# BEGIN KödMem local working memory\n/.kodade/memory/\n# END KödMem local working memory\n";
const RECENT_WORKLOG_BYTES: usize = 32 * 1024;
const STATE_BYTES: usize = 32 * 1024;
const WORKLOG_ARCHIVE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkingMemoryMode {
    Commit,
    Local,
}

impl WorkingMemoryMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Commit => "commit",
            Self::Local => "local",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "commit" => Ok(Self::Commit),
            "local" => Ok(Self::Local),
            other => Err(MemoryError::InvalidInput(format!(
                "unknown working-memory mode in database: {other}"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingMemoryStatus {
    pub enabled: bool,
    pub mode: WorkingMemoryMode,
    pub directory: String,
    pub state_path: String,
    pub worklog_path: String,
    pub decisions_path: String,
    pub last_indexed_at: Option<i64>,
    pub last_commit: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingMemoryContext {
    pub directory: String,
    pub state: String,
    pub recent_worklog: String,
}

#[derive(Debug)]
struct IndexedFile {
    id: String,
    relative_path: String,
    title: String,
    body: String,
    kind: MemoryKind,
    updated_at: i64,
}

impl MemoryStore {
    pub fn activate_working_memory(
        &self,
        workspace_id: &str,
        mode: WorkingMemoryMode,
        export_existing: bool,
    ) -> Result<WorkingMemoryStatus> {
        self.require_writable_working_memory()?;
        if self.portable_authority(workspace_id)?.is_some() {
            return Err(MemoryError::InvalidInput(
                "projects-vault is authoritative for this project; repo-local working memory cannot be activated"
                    .into(),
            ));
        }
        // One knowledge surface per workspace, checked for local surfaces only:
        // a vault mapping still activates legacy working memory before its
        // cutover, and portable_authority above already covers it afterwards.
        // A local surface that is enabled but not yet scaffolded has no
        // Project.md marker, so it reports no authority while still owning this
        // workspace's knowledge - hence the direct config check.
        if self
            .workspace_knowledge_surface(workspace_id)?
            .is_some_and(|surface| surface.mode == super::KnowledgeSurfaceMode::Local)
        {
            return Err(MemoryError::InvalidInput(
                "this workspace already uses a local KödMem knowledge surface; turn it off before activating repo-local working memory"
                    .into(),
            ));
        }
        let workspace = self.workspace(workspace_id)?;
        let root = PathBuf::from(&workspace.canonical_root);
        let directory = working_directory(&root)?;
        reject_symlinked_memory_path(&root, &directory)?;
        update_gitignore(&root, mode)?;
        std::fs::create_dir_all(directory.join("plans"))?;
        reject_symlinked_memory_path(&root, &directory)?;

        let now = now_millis();
        create_if_missing(
            &directory.join(STATE_FILE),
            &format!(
                "# Project state\n\nUpdated: {}\n\n## Current state\n\nKödMem working memory is active. No checkpoint has been recorded yet.\n\n## Next steps\n\n- Leave a checkpoint at the next natural handoff.\n",
                crate::config::iso_timestamp(SystemTime::now())
            ),
        )?;
        create_if_missing(&directory.join(WORKLOG_FILE), "# Project worklog\n\n")?;
        create_if_missing(&directory.join(DECISIONS_FILE), "# Decisions\n\n")?;
        if export_existing && !directory.join(IMPORTED_FILE).exists() {
            atomic_write(
                &directory.join(IMPORTED_FILE),
                &self.render_existing_memories(workspace_id)?,
            )?;
        }
        collect_markdown_files(&root, &directory, workspace_id)?;
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection.execute(
                "INSERT INTO working_memory_config (
                    workspace_id, mode, activated_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?3)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                    mode = excluded.mode,
                    updated_at = excluded.updated_at",
                params![workspace_id, mode.as_str(), now],
            )?;
            Ok(())
        })?;
        self.sync_working_memory(workspace_id)?;
        self.working_memory_status(workspace_id)?
            .ok_or_else(|| MemoryError::InvalidInput("working memory did not activate".into()))
    }

    pub fn working_memory_status(&self, workspace_id: &str) -> Result<Option<WorkingMemoryStatus>> {
        self.workspace(workspace_id)?;
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let row = connection
                .query_row(
                    "SELECT mode, last_indexed_at, last_commit
                     FROM working_memory_config WHERE workspace_id = ?1",
                    [workspace_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?;
            row.map(|(mode, last_indexed_at, last_commit)| {
                let mode = WorkingMemoryMode::parse(&mode)?;
                Ok(status_for(mode, last_indexed_at, last_commit))
            })
            .transpose()
        })
    }

    pub fn sync_working_memory(&self, workspace_id: &str) -> Result<u64> {
        let lock = lock_working_memory(&self.path, workspace_id)?;
        let result = self.sync_working_memory_unlocked(workspace_id);
        unlock_working_memory(&lock);
        result
    }

    fn sync_working_memory_unlocked(&self, workspace_id: &str) -> Result<u64> {
        self.require_writable_working_memory()?;
        let workspace = self.workspace(workspace_id)?;
        if self.working_memory_status(workspace_id)?.is_none() {
            return Err(MemoryError::InvalidInput(
                "working memory is not active for this workspace".into(),
            ));
        }
        let root = PathBuf::from(&workspace.canonical_root);
        let directory = working_directory(&root)?;
        reject_symlinked_memory_path(&root, &directory)?;
        let files = collect_markdown_files(&root, &directory, workspace_id)?;
        let indexed_at = now_millis();
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM working_memory_files WHERE workspace_id = ?1",
                [workspace_id],
            )?;
            for file in &files {
                transaction.execute(
                    "INSERT INTO working_memory_files (
                        id, workspace_id, relative_path, title, body, kind, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        file.id,
                        workspace_id,
                        file.relative_path,
                        file.title,
                        file.body,
                        file.kind.as_str(),
                        file.updated_at,
                    ],
                )?;
            }
            transaction.execute(
                "UPDATE working_memory_config SET last_indexed_at = ?1, updated_at = ?1
                 WHERE workspace_id = ?2",
                params![indexed_at, workspace_id],
            )?;
            transaction.commit()?;
            Ok(files.len() as u64)
        })
    }

    pub(crate) fn working_memory_context(
        &self,
        workspace: &Workspace,
    ) -> Result<Option<WorkingMemoryContext>> {
        if self.working_memory_status(&workspace.id)?.is_none() {
            return Ok(None);
        }
        let root = PathBuf::from(&workspace.canonical_root);
        let directory = working_directory(&root)?;
        reject_symlinked_memory_path(&root, &directory)?;
        let state = read_confined_file(&root, &directory.join(STATE_FILE))?;
        let worklog = read_confined_file(&root, &directory.join(WORKLOG_FILE))?;
        Ok(Some(WorkingMemoryContext {
            directory: MEMORY_DIRECTORY.into(),
            state,
            recent_worklog: tail_bytes(&worklog, RECENT_WORKLOG_BYTES),
        }))
    }

    pub(crate) fn working_memory_search_hits(
        &self,
        query: &MemoryQuery,
    ) -> Result<Page<MemorySearchHit>> {
        if query
            .sources
            .iter()
            .any(|source| *source != MemorySource::Kodade)
            && !query.sources.is_empty()
            && !query.sources.contains(&MemorySource::Kodade)
        {
            return Ok(Page {
                items: Vec::new(),
                total: 0,
                limit: query.limit.clamp(1, 100),
                offset: query.offset,
            });
        }
        let connection = self.connection()?;
        let mut filters = String::from("f.workspace_id = ?");
        let mut values = vec![Value::Text(query.workspace_id.clone())];
        if !query.kinds.is_empty() {
            filters.push_str(" AND f.kind IN (");
            filters.push_str(
                &std::iter::repeat_n("?", query.kinds.len())
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            filters.push(')');
            values.extend(
                query
                    .kinds
                    .iter()
                    .map(|kind| Value::Text(kind.as_str().into())),
            );
        }
        if let Some(updated_after) = query.updated_after {
            filters.push_str(" AND f.updated_at >= ?");
            values.push(Value::Integer(updated_after));
        }
        let (from, excerpt, order) = if let Some(text) = fts_query(&query.text) {
            filters.push_str(" AND working_memory_fts MATCH ?");
            values.push(Value::Text(text));
            (
                "working_memory_fts JOIN working_memory_files f ON f.id = working_memory_fts.file_id",
                "snippet(working_memory_fts, 3, '<mark>', '</mark>', '…', 20)",
                "bm25(working_memory_fts), f.updated_at DESC, f.id",
            )
        } else {
            (
                "working_memory_files f",
                "substr(f.body, 1, 240)",
                "f.updated_at DESC, f.id",
            )
        };
        let total = connection.query_row(
            &format!("SELECT COUNT(*) FROM {from} WHERE {filters}"),
            params_from_iter(values.iter()),
            |row| row.get(0),
        )?;
        let limit = query.limit.clamp(1, 100);
        values.push(Value::Integer(i64::from(limit)));
        values.push(Value::Integer(i64::from(query.offset)));
        let sql = format!(
            "SELECT f.id, f.workspace_id, f.kind, f.title, {excerpt},
                    f.updated_at, f.relative_path
             FROM {from} WHERE {filters} ORDER BY {order} LIMIT ? OFFSET ?"
        );
        let mut statement = connection.prepare(&sql)?;
        let items = statement
            .query_map(params_from_iter(values), |row| {
                let kind =
                    MemoryKind::parse(row.get(2)?).map_err(super::to_sql_conversion_error)?;
                Ok(MemorySearchHit {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    kind,
                    title: row.get(3)?,
                    excerpt: row.get(4)?,
                    source: MemorySource::Kodade,
                    pinned: false,
                    version: 1,
                    updated_at: row.get(5)?,
                    file_path: Some(row.get(6)?),
                    project_source: None,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Page {
            items,
            total,
            limit,
            offset: query.offset,
        })
    }

    pub(crate) fn write_checkpoint_working_memory(
        &self,
        checkpoint: &Checkpoint,
        update_state: bool,
    ) -> Result<()> {
        let Some(_) = self.working_memory_status(&checkpoint.workspace_id)? else {
            return Ok(());
        };
        let workspace = self.workspace(&checkpoint.workspace_id)?;
        let root = PathBuf::from(&workspace.canonical_root);
        let directory = working_directory(&root)?;
        reject_symlinked_memory_path(&root, &directory)?;
        let lock = lock_working_memory(&self.path, &checkpoint.workspace_id)?;
        let result: Result<()> = (|| {
            let timestamp = crate::config::iso_timestamp(
                UNIX_EPOCH + std::time::Duration::from_millis(checkpoint.created_at.max(0) as u64),
            );
            let marker = format!("<!-- checkpoint:{} -->", checkpoint.id);
            let mut worklog = read_confined_file(&root, &directory.join(WORKLOG_FILE))?;
            if !worklog_marker_exists(&root, &directory, &marker)? {
                let entry = render_checkpoint_entry(checkpoint, &timestamp, &marker);
                if worklog.len().saturating_add(entry.len()) > WORKLOG_ARCHIVE_BYTES {
                    archive_worklog(&root, &directory, &timestamp, &worklog)?;
                    worklog = String::from("# Project worklog\n\n");
                }
                worklog.push_str(&entry);
                atomic_write(&directory.join(WORKLOG_FILE), &worklog)?;
            }

            let mut decisions = read_confined_file(&root, &directory.join(DECISIONS_FILE))?;
            if !checkpoint.decisions.is_empty() && !decisions.contains(&marker) {
                decisions.push_str(&format!("## {timestamp}\n\n{marker}\n"));
                for decision in &checkpoint.decisions {
                    decisions.push_str(&format!("- {}\n", single_line(decision)));
                }
                decisions.push('\n');
                atomic_write(&directory.join(DECISIONS_FILE), &decisions)?;
            }

            if update_state && self.is_latest_checkpoint(checkpoint)? {
                reject_symlink_file(&directory.join(STATE_FILE))?;
                let state = bounded_utf8(&render_state(checkpoint, &timestamp), STATE_BYTES);
                atomic_write(&directory.join(STATE_FILE), &state)?;
            }
            self.sync_working_memory_unlocked(&checkpoint.workspace_id)?;
            Ok(())
        })();
        unlock_working_memory(&lock);
        result
    }

    pub fn checkpoint_activity_fallback(
        &self,
        event: &ActivityEvent,
    ) -> Result<Option<Checkpoint>> {
        if event.kind != ActivityKind::SessionExited {
            return Ok(None);
        }
        let portable = self.portable_authority(&event.workspace_id)?.is_some();
        if !portable && self.working_memory_status(&event.workspace_id)?.is_none() {
            return Ok(None);
        }
        let subject = event
            .session_id
            .as_deref()
            .map(|session| format!("Session {session}"))
            .unwrap_or_else(|| "Project session".into());
        let (mut changed_paths, provider, started_at) = self.session_activity_metadata(event)?;
        changed_paths.truncate(20);
        let provider = provider
            .as_deref()
            .map(|value| format!(" using {value}"))
            .unwrap_or_default();
        let duration = started_at
            .map(|started| event.occurred_at.saturating_sub(started).max(0) / 60_000)
            .map(|minutes| {
                format!(
                    " after {minutes} minute{}",
                    if minutes == 1 { "" } else { "s" }
                )
            })
            .unwrap_or_default();
        let files = if changed_paths.is_empty() {
            String::new()
        } else {
            format!(
                " {} file{} touched.",
                changed_paths.len(),
                if changed_paths.len() == 1 { "" } else { "s" }
            )
        };
        self.checkpoint_with_state(
            NewCheckpoint {
                workspace_id: event.workspace_id.clone(),
                summary: format!("{subject} ended in Ködade{provider}{duration}.{files}"),
                decisions: Vec::new(),
                next_actions: Vec::new(),
                changed_paths,
                source: MemorySource::Kodade,
                source_client: event.source.clone(),
                session_id: event.session_id.clone(),
                idempotency_key: Some(format!("activity:{}", event.id)),
            },
            false,
        )
        .map(Some)
    }

    fn session_activity_metadata(
        &self,
        event: &ActivityEvent,
    ) -> Result<(Vec<String>, Option<String>, Option<i64>)> {
        let Some(session_id) = event.session_id.as_deref() else {
            return Ok((Vec::new(), event.provider.clone(), None));
        };
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT relative_path FROM activity_events
                 WHERE workspace_id = ?1 AND session_id = ?2
                       AND kind = 'file_saved' AND relative_path IS NOT NULL
                 GROUP BY relative_path ORDER BY MIN(sequence) LIMIT 100",
            )?;
            let paths = statement
                .query_map(params![event.workspace_id, session_id], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            let provider = connection
                .query_row(
                    "SELECT provider FROM activity_events
                     WHERE workspace_id = ?1 AND session_id = ?2 AND provider IS NOT NULL
                     ORDER BY sequence DESC LIMIT 1",
                    params![event.workspace_id, session_id],
                    |row| row.get(0),
                )
                .optional()?;
            let started_at = connection.query_row(
                "SELECT MIN(occurred_at) FROM activity_events
                 WHERE workspace_id = ?1 AND session_id = ?2",
                params![event.workspace_id, session_id],
                |row| row.get::<_, Option<i64>>(0),
            )?;
            Ok((paths, provider, started_at))
        })
    }

    pub fn observe_working_memory_commit(
        &self,
        workspace_id: &str,
        head: &str,
    ) -> Result<Option<Checkpoint>> {
        let head = head.trim();
        if !matches!(head.len(), 40 | 64) || !head.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(MemoryError::InvalidInput(
                "observed Git commit must be a 40- or 64-character hexadecimal object id".into(),
            ));
        }
        let portable = self.portable_authority(workspace_id)?.is_some();
        let current_commit = if portable {
            self.portable_observed_commit(workspace_id)?
        } else {
            let Some(status) = self.working_memory_status(workspace_id)? else {
                return Ok(None);
            };
            status.last_commit
        };
        if current_commit.as_deref() == Some(head) {
            return Ok(None);
        }
        if current_commit.is_none() {
            if portable {
                self.set_portable_observed_commit(workspace_id, head)?;
            } else {
                self.set_working_memory_commit(workspace_id, head)?;
            }
            return Ok(None);
        }
        let short = &head[..12];
        let checkpoint = self.checkpoint_with_state(
            NewCheckpoint {
                workspace_id: workspace_id.into(),
                summary: format!("Git commit {short} detected."),
                decisions: Vec::new(),
                next_actions: Vec::new(),
                changed_paths: Vec::new(),
                source: MemorySource::Kodade,
                source_client: "kodade-ui".into(),
                session_id: None,
                idempotency_key: Some(format!("git:{head}")),
            },
            false,
        )?;
        if portable {
            self.set_portable_observed_commit(workspace_id, head)?;
        } else {
            self.set_working_memory_commit(workspace_id, head)?;
        }
        Ok(Some(checkpoint))
    }

    fn portable_observed_commit(&self, workspace_id: &str) -> Result<Option<String>> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection
                .query_row(
                    "SELECT last_commit FROM portable_observation WHERE workspace_id = ?1",
                    [workspace_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(Into::into)
        })
    }

    fn set_portable_observed_commit(&self, workspace_id: &str, head: &str) -> Result<()> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection.execute(
                "INSERT INTO portable_observation(workspace_id, last_commit, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                    last_commit = excluded.last_commit,
                    updated_at = excluded.updated_at",
                params![workspace_id, head, now_millis()],
            )?;
            Ok(())
        })
    }

    fn set_working_memory_commit(&self, workspace_id: &str, head: &str) -> Result<()> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            connection.execute(
                "UPDATE working_memory_config SET last_commit = ?1, updated_at = ?2
                 WHERE workspace_id = ?3",
                params![head, now_millis(), workspace_id],
            )?;
            Ok(())
        })
    }

    fn is_latest_checkpoint(&self, checkpoint: &Checkpoint) -> Result<bool> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let latest = connection.query_row(
                "SELECT id FROM checkpoints
                 WHERE workspace_id = ?1 AND updates_state = 1
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [&checkpoint.workspace_id],
                |row| row.get::<_, String>(0),
            )?;
            Ok(latest == checkpoint.id)
        })
    }

    fn render_existing_memories(&self, workspace_id: &str) -> Result<String> {
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT kind, title, body, source, updated_at FROM memories
                 WHERE workspace_id = ?1 AND deleted_at IS NULL
                 ORDER BY updated_at, id",
            )?;
            let rows = statement
                .query_map([workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut markdown = String::from("# Exported durable memories\n\n");
            if rows.is_empty() {
                markdown.push_str("No durable memories existed when this snapshot was exported.\n");
            }
            for (kind, title, body, source, updated_at) in rows {
                markdown.push_str(&format!(
                    "## {}\n\n- Kind: `{kind}`\n- Source: `{source}`\n- Updated: `{updated_at}`\n\n{}\n\n",
                    title.trim(),
                    body.trim()
                ));
            }
            Ok(markdown)
        })
    }

    fn require_writable_working_memory(&self) -> Result<()> {
        if matches!(self.access, StoreAccess::ReadOnly) {
            Err(MemoryError::InvalidInput(
                "read-only memory stores cannot change project working memory".into(),
            ))
        } else {
            Ok(())
        }
    }
}

fn status_for(
    mode: WorkingMemoryMode,
    last_indexed_at: Option<i64>,
    last_commit: Option<String>,
) -> WorkingMemoryStatus {
    WorkingMemoryStatus {
        enabled: true,
        mode,
        directory: MEMORY_DIRECTORY.into(),
        state_path: format!("{MEMORY_DIRECTORY}/{STATE_FILE}"),
        worklog_path: format!("{MEMORY_DIRECTORY}/{WORKLOG_FILE}"),
        decisions_path: format!("{MEMORY_DIRECTORY}/{DECISIONS_FILE}"),
        last_indexed_at,
        last_commit,
    }
}

fn working_directory(root: &Path) -> Result<PathBuf> {
    if !root.is_absolute() || !root.is_dir() {
        return Err(MemoryError::InvalidInput(
            "working-memory workspace root must be an existing absolute directory".into(),
        ));
    }
    Ok(root.join(".kodade").join("memory"))
}

fn reject_symlinked_memory_path(root: &Path, directory: &Path) -> Result<()> {
    for path in [
        root.join(".kodade"),
        directory.to_path_buf(),
        directory.join("plans"),
    ] {
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(MemoryError::InvalidInput(format!(
                    "working-memory path cannot be a symlink: {}",
                    path.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        }
    }
    if !directory.exists() {
        return Ok(());
    }
    let canonical_root = std::fs::canonicalize(root)?;
    let canonical_directory = std::fs::canonicalize(directory)?;
    if !canonical_directory.starts_with(&canonical_root) {
        return Err(MemoryError::InvalidInput(
            "working-memory directory escapes the registered workspace".into(),
        ));
    }
    Ok(())
}

fn create_if_missing(path: &Path, contents: &str) -> Result<()> {
    match OpenOptions::new().create_new(true).write(true).open(path) {
        Ok(mut file) => {
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn update_gitignore(root: &Path, mode: WorkingMemoryMode) -> Result<()> {
    let path = root.join(".gitignore");
    let current = match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(MemoryError::InvalidInput(
                ".gitignore cannot be a symlink when KödMem manages its local rule".into(),
            ));
        }
        Ok(_) => std::fs::read_to_string(&path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let managed = format!("\n\n{LOCAL_GITIGNORE_BLOCK}");
    let has_start = current.contains(LOCAL_GITIGNORE_START);
    let has_end = current.contains(LOCAL_GITIGNORE_END);
    if (has_start || has_end) && !current.contains(LOCAL_GITIGNORE_BLOCK) {
        return Err(MemoryError::InvalidInput(
            "the KödMem .gitignore block is incomplete or modified; remove it and activate local mode again"
                .into(),
        ));
    }
    let next = match mode {
        WorkingMemoryMode::Local if current.contains(LOCAL_GITIGNORE_BLOCK) => current.clone(),
        WorkingMemoryMode::Local if current.is_empty() => LOCAL_GITIGNORE_BLOCK.into(),
        WorkingMemoryMode::Local => format!("{}{}", current.trim_end_matches('\n'), managed),
        WorkingMemoryMode::Commit => remove_managed_gitignore_block(&current),
    };
    if next != current {
        atomic_write(&path, &next)?;
    }
    Ok(())
}

fn remove_managed_gitignore_block(current: &str) -> String {
    let Some(start) = current.find(LOCAL_GITIGNORE_START) else {
        return current.to_string();
    };
    let Some(relative_end) = current[start..].find(LOCAL_GITIGNORE_END) else {
        return current.to_string();
    };
    let mut end = start + relative_end + LOCAL_GITIGNORE_END.len();
    if current.as_bytes().get(end) == Some(&b'\n') {
        end += 1;
    }
    let mut next = format!("{}{}", &current[..start], &current[end..]);
    while next.contains("\n\n\n") {
        next = next.replace("\n\n\n", "\n\n");
    }
    next
}

fn collect_markdown_files(
    root: &Path,
    directory: &Path,
    workspace_id: &str,
) -> Result<Vec<IndexedFile>> {
    let mut paths = vec![
        directory.join(STATE_FILE),
        directory.join(WORKLOG_FILE),
        directory.join(DECISIONS_FILE),
    ];
    for item in std::fs::read_dir(directory)? {
        let item = item?;
        let path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        if item.file_type()?.is_file() && name.starts_with("WORKLOG-") && name.ends_with(".md") {
            paths.push(path);
        }
    }
    let plans = directory.join("plans");
    if plans.is_dir() {
        reject_symlink_file(&plans)?;
        for item in std::fs::read_dir(plans)? {
            let item = item?;
            let path = item.path();
            if item.file_type()?.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("md")
            {
                paths.push(path);
            }
        }
    }
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let body = read_confined_file(root, &path)?;
            let relative = path.strip_prefix(root).map_err(|_| {
                MemoryError::InvalidInput("working-memory file escaped the workspace".into())
            })?;
            let relative_path = relative.to_string_lossy().replace('\\', "/");
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("memory");
            let title = body
                .lines()
                .find_map(|line| line.strip_prefix("# "))
                .unwrap_or(file_name.trim_end_matches(".md"))
                .trim()
                .to_string();
            let kind = if file_name.eq_ignore_ascii_case(DECISIONS_FILE) {
                MemoryKind::Decision
            } else {
                MemoryKind::Summary
            };
            let updated_at = std::fs::metadata(&path)?
                .modified()
                .unwrap_or(UNIX_EPOCH)
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            Ok(IndexedFile {
                id: format!("working:{workspace_id}:{relative_path}"),
                relative_path,
                title,
                body,
                kind,
                updated_at,
            })
        })
        .collect()
}

fn reject_symlink_file(path: &Path) -> Result<()> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(MemoryError::InvalidInput(format!(
            "working-memory path cannot be a symlink: {}",
            path.display()
        )));
    }
    Ok(())
}

fn read_confined_file(root: &Path, path: &Path) -> Result<String> {
    reject_symlink_file(path)?;
    let canonical_root = std::fs::canonicalize(root)?;
    let canonical_path = std::fs::canonicalize(path)?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(MemoryError::InvalidInput(format!(
            "working-memory file escapes the workspace: {}",
            path.display()
        )));
    }
    std::fs::read_to_string(canonical_path).map_err(Into::into)
}

fn worklog_marker_exists(root: &Path, directory: &Path, marker: &str) -> Result<bool> {
    for item in std::fs::read_dir(directory)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if item.file_type()?.is_file()
            && (name == WORKLOG_FILE || (name.starts_with("WORKLOG-") && name.ends_with(".md")))
            && read_confined_file(root, &item.path())?.contains(marker)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn tail_bytes(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

fn render_state(checkpoint: &Checkpoint, timestamp: &str) -> String {
    let mut output = format!(
        "# Project state\n\nUpdated: {timestamp}\nSource: {}{}\n\n## Current state\n\n{}\n",
        checkpoint.source_client,
        checkpoint
            .session_id
            .as_deref()
            .map(|session| format!(" · {session}"))
            .unwrap_or_default(),
        checkpoint.summary.trim()
    );
    if !checkpoint.decisions.is_empty() {
        output.push_str("\n## Decisions\n\n");
        for decision in &checkpoint.decisions {
            output.push_str(&format!("- {}\n", single_line(decision)));
        }
    }
    output.push_str("\n## Next steps\n\n");
    if checkpoint.next_actions.is_empty() {
        output.push_str("- No next actions recorded.\n");
    } else {
        for action in &checkpoint.next_actions {
            output.push_str(&format!("- {}\n", single_line(action)));
        }
    }
    if !checkpoint.changed_paths.is_empty() {
        output.push_str("\n## Changed paths\n\n");
        for path in &checkpoint.changed_paths {
            output.push_str(&format!("- `{}`\n", path.trim()));
        }
    }
    output
}

fn render_checkpoint_entry(checkpoint: &Checkpoint, timestamp: &str, marker: &str) -> String {
    let mut entry = format!(
        "## {timestamp} — {}{}\n\n{marker}\n{}\n",
        checkpoint.source_client,
        checkpoint
            .session_id
            .as_deref()
            .map(|session| format!(" · {session}"))
            .unwrap_or_default(),
        checkpoint.summary.trim()
    );
    if !checkpoint.decisions.is_empty() {
        entry.push_str("\n**Decisions**\n");
        for decision in &checkpoint.decisions {
            entry.push_str(&format!("- {}\n", single_line(decision)));
        }
    }
    if !checkpoint.next_actions.is_empty() {
        entry.push_str("\n**Next**\n");
        for action in &checkpoint.next_actions {
            entry.push_str(&format!("- {}\n", single_line(action)));
        }
    }
    if !checkpoint.changed_paths.is_empty() {
        entry.push_str("\n**Changed**\n");
        for path in &checkpoint.changed_paths {
            entry.push_str(&format!("- `{}`\n", path.trim()));
        }
    }
    entry.push('\n');
    entry
}

fn archive_worklog(root: &Path, directory: &Path, timestamp: &str, current: &str) -> Result<()> {
    let year = timestamp.get(0..4).unwrap_or("archive");
    let path = directory.join(format!("WORKLOG-{year}.md"));
    let mut archive = if path.exists() {
        read_confined_file(root, &path)?
    } else {
        format!("# Project worklog archive — {year}\n\n")
    };
    let body = current
        .strip_prefix("# Project worklog\n\n")
        .unwrap_or(current);
    if !body.trim().is_empty() {
        archive.push_str(body);
        if !archive.ends_with('\n') {
            archive.push('\n');
        }
        atomic_write(&path, &archive)?;
    }
    Ok(())
}

fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn bounded_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let suffix = "\n\n[State truncated by KödMem; full checkpoint remains in WORKLOG.md.]\n";
    let mut end = limit.saturating_sub(suffix.len());
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}{}", &value[..end], suffix)
}

fn atomic_write(path: &Path, contents: &str) -> Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().ok_or_else(|| {
        MemoryError::InvalidInput(format!(
            "working-memory file has no parent: {}",
            path.display()
        ))
    })?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".kodade-memory-{}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        crate::fs::atomic_replace(&temporary, path)?;
        Ok::<(), std::io::Error>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(Into::into)
}

fn lock_working_memory(database: &Path, workspace_id: &str) -> Result<File> {
    let lock_path = PathBuf::from(format!(
        "{}.working-{workspace_id}.lock",
        database.display()
    ));
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    lock.lock_exclusive()?;
    Ok(lock)
}

fn unlock_working_memory(lock: &File) {
    let _ = FileExt::unlock(lock);
}
