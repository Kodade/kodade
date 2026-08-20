use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::super::{
    fts_query, now_millis, validate_no_likely_credential, MemoryKind, MemoryQuery, MemorySearchHit,
    MemorySource, MemoryStore, Page, Result, StoreAccess,
};
use super::{KnowledgeSurfaceMode, ProjectLocation};

mod source;

use source::{
    bounded_chars, collect_project_documents, collect_project_documents_with_project_override,
    project_context,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectKnowledgeKind {
    Project,
    State,
    Worklog,
    Decision,
    Knowledge,
}

impl ProjectKnowledgeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::State => "state",
            Self::Worklog => "worklog",
            Self::Decision => "decision",
            Self::Knowledge => "knowledge",
        }
    }

    fn memory_kind(self) -> MemoryKind {
        match self {
            Self::Decision => MemoryKind::Decision,
            Self::Knowledge => MemoryKind::Fact,
            Self::Project | Self::State | Self::Worklog => MemoryKind::Summary,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectKnowledgeSyncStatus {
    Current,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKnowledgeSync {
    pub status: ProjectKnowledgeSyncStatus,
    pub refreshed_at: i64,
    pub indexed_documents: u32,
    pub index_hash: Option<String>,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKnowledgeSource {
    pub kind: ProjectKnowledgeKind,
    pub relative_path: String,
    pub title: String,
    pub content: String,
    pub sha256: String,
    pub modified_at: i64,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKnowledgeProvenance {
    pub project_id: String,
    pub relative_path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKnowledgeContext {
    pub project_id: String,
    pub project_display_name: String,
    pub origin: String,
    pub sync: ProjectKnowledgeSync,
    pub sources: Vec<ProjectKnowledgeSource>,
}

#[derive(Clone, Debug)]
struct IndexedProjectDocument {
    id: String,
    project_id: String,
    relative_path: String,
    kind: ProjectKnowledgeKind,
    memory_kind: MemoryKind,
    memory_source: MemorySource,
    memory_pinned: bool,
    canonical_record_id: Option<String>,
    canonical_version: Option<u64>,
    canonical_updated_at: Option<i64>,
    title: String,
    body: String,
    sha256: String,
    modified_at: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectKnowledgeRefresh {
    context: ProjectKnowledgeContext,
    documents: Vec<IndexedProjectDocument>,
}

impl MemoryStore {
    pub(crate) fn validate_project_knowledge_sources(
        &self,
        location: &ProjectLocation,
    ) -> Result<()> {
        let _ = collect_project_documents(location)?;
        Ok(())
    }

    pub(crate) fn stage_project_knowledge(
        &self,
        workspace_id: &str,
        prospective_project: &str,
    ) -> Result<()> {
        let location = self.project_location(workspace_id)?.ok_or_else(|| {
            super::super::MemoryError::InvalidInput(
                "mapped project disappeared while staging migration knowledge".into(),
            )
        })?;
        let documents =
            collect_project_documents_with_project_override(&location, Some(prospective_project))?;
        if matches!(self.access, StoreAccess::ReadOnly) {
            return Err(super::super::MemoryError::InvalidInput(
                "read-only stores cannot stage project knowledge".into(),
            ));
        }
        self.replace_project_document_index(&location.project_id, &documents, now_millis())
    }

    pub(crate) fn project_knowledge_context(
        &self,
        workspace_id: &str,
    ) -> Result<Option<ProjectKnowledgeContext>> {
        Ok(self
            .refresh_project_knowledge(workspace_id)?
            .map(|refresh| refresh.context))
    }

    pub(crate) fn refresh_project_knowledge(
        &self,
        workspace_id: &str,
    ) -> Result<Option<ProjectKnowledgeRefresh>> {
        let Some(location) = self.project_location(workspace_id)? else {
            return Ok(None);
        };
        let refreshed_at = now_millis();
        match collect_project_documents(&location) {
            Ok(documents) => {
                if !matches!(self.access, StoreAccess::ReadOnly) {
                    self.replace_project_document_index(&location.project_id, &documents, refreshed_at)?;
                }
                let context = project_context(&location, &documents, refreshed_at);
                Ok(Some(ProjectKnowledgeRefresh { context, documents }))
            }
            Err(error) => Ok(Some(ProjectKnowledgeRefresh {
                context: ProjectKnowledgeContext {
                    project_id: location.project_id,
                    project_display_name: location.project_display_name,
                    origin: location.project_root.to_string_lossy().into_owned(),
                    sync: ProjectKnowledgeSync {
                        status: ProjectKnowledgeSyncStatus::Error,
                        refreshed_at,
                        indexed_documents: 0,
                        index_hash: None,
                        truncated: false,
                        error: Some(format!(
                            "KödMem could not refresh mapped project knowledge: {error}. Repair the mapped project folder and retry."
                        )),
                    },
                    sources: Vec::new(),
                },
                documents: Vec::new(),
            })),
        }
    }

    pub(crate) fn project_knowledge_search_hits(
        &self,
        query: &MemoryQuery,
        refresh: Option<&ProjectKnowledgeRefresh>,
    ) -> Result<Page<MemorySearchHit>> {
        let limit = query.limit.clamp(1, 100);
        let Some(refresh) = refresh else {
            return Ok(empty_page(limit, query.offset));
        };
        if refresh.context.sync.status == ProjectKnowledgeSyncStatus::Error {
            return Ok(empty_page(limit, query.offset));
        }
        if matches!(self.access, StoreAccess::ReadOnly) {
            return search_documents_direct(query, refresh);
        }
        search_project_document_index(self, query, refresh)
    }

    pub(crate) fn project_location(&self, workspace_id: &str) -> Result<Option<ProjectLocation>> {
        validate_no_likely_credential("workspace id", workspace_id)?;
        self.run_with_recovery(|| {
            let connection = self.connection()?;
            // Local knowledge surfaces are an explicit opt-in row. Every other
            // workspace - including every legacy config - falls through to the
            // unchanged projects-vault mapping query below.
            if let Some(surface) =
                super::local_knowledge_surface_with_connection(&connection, workspace_id)?
            {
                let project_root = PathBuf::from(&surface.knowledge_root);
                return Ok(Some(ProjectLocation {
                    project_id: surface.project_id,
                    project_display_name: surface.project_display_name,
                    mode: KnowledgeSurfaceMode::Local,
                    surface_root: project_root.clone(),
                    project_root,
                }));
            }
            connection
                .query_row(
                    "SELECT m.project_id, p.display_name, v.canonical_root
                     FROM workspace_project_mappings m
                     JOIN logical_projects p ON p.id = m.project_id
                     JOIN projects_vault_config v ON v.singleton = 1
                     WHERE m.workspace_id = ?1",
                    [workspace_id],
                    |row| {
                        let project_id = row.get::<_, String>(0)?;
                        let vault_root = PathBuf::from(row.get::<_, String>(2)?);
                        Ok(ProjectLocation {
                            project_root: vault_root.join("10-Projects").join(&project_id),
                            project_id,
                            project_display_name: row.get(1)?,
                            mode: KnowledgeSurfaceMode::Vault,
                            surface_root: vault_root,
                        })
                    },
                )
                .optional()
                .map_err(Into::into)
        })
    }

    fn replace_project_document_index(
        &self,
        project_id: &str,
        documents: &[IndexedProjectDocument],
        indexed_at: i64,
    ) -> Result<()> {
        self.run_with_recovery(|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute(
                "DELETE FROM project_documents WHERE project_id = ?1",
                [project_id],
            )?;
            for document in documents {
                transaction.execute(
                    "INSERT INTO project_documents (
                        id, project_id, relative_path, kind, memory_kind, memory_source,
                        memory_pinned, canonical_record_id, memory_version, memory_updated_at,
                        title, body, sha256, modified_at, indexed_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                    params![
                        document.id,
                        document.project_id,
                        document.relative_path,
                        document.kind.as_str(),
                        document.memory_kind.as_str(),
                        document.memory_source.as_str(),
                        document.memory_pinned,
                        document.canonical_record_id,
                        document.canonical_version.unwrap_or(1),
                        document.canonical_updated_at,
                        document.title,
                        document.body,
                        document.sha256,
                        document.modified_at,
                        indexed_at,
                    ],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
    }
}

fn empty_page(limit: u32, offset: u32) -> Page<MemorySearchHit> {
    Page {
        items: Vec::new(),
        total: 0,
        limit,
        offset,
    }
}

fn search_project_document_index(
    store: &MemoryStore,
    query: &MemoryQuery,
    refresh: &ProjectKnowledgeRefresh,
) -> Result<Page<MemorySearchHit>> {
    let project_id = &refresh.context.project_id;
    let connection = store.connection()?;
    let mut filters = String::from(
        "d.project_id = ? AND NOT EXISTS (
            SELECT 1 FROM memories m
            WHERE m.workspace_id = ? AND m.canonical_project_id = d.project_id
              AND m.canonical_relative_path = d.relative_path
         )",
    );
    let mut values = vec![
        Value::Text(project_id.clone()),
        Value::Text(query.workspace_id.clone()),
    ];
    if !query.kinds.is_empty() {
        let allowed = query
            .kinds
            .iter()
            .map(|kind| Value::Text(kind.as_str().into()))
            .collect::<Vec<_>>();
        filters.push_str(" AND d.memory_kind IN (");
        filters.push_str(
            &std::iter::repeat_n("?", allowed.len())
                .collect::<Vec<_>>()
                .join(", "),
        );
        filters.push(')');
        values.extend(allowed);
    }
    if !query.sources.is_empty() {
        let allowed = query
            .sources
            .iter()
            .map(|source| Value::Text(source.as_str().into()))
            .collect::<Vec<_>>();
        filters.push_str(" AND d.memory_source IN (");
        filters.push_str(
            &std::iter::repeat_n("?", allowed.len())
                .collect::<Vec<_>>()
                .join(", "),
        );
        filters.push(')');
        values.extend(allowed);
    }
    if let Some(updated_after) = query.updated_after {
        filters.push_str(" AND COALESCE(d.memory_updated_at, d.modified_at) >= ?");
        values.push(updated_after.into());
    }
    let (from, excerpt, order) = if let Some(text) = fts_query(&query.text) {
        filters.push_str(" AND project_document_fts MATCH ?");
        values.push(text.into());
        (
            "project_document_fts JOIN project_documents d ON d.id = project_document_fts.document_id",
            "snippet(project_document_fts, 3, '<mark>', '</mark>', '…', 20)",
            "bm25(project_document_fts), COALESCE(d.memory_updated_at, d.modified_at) DESC, d.id",
        )
    } else {
        (
            "project_documents d",
            "substr(d.body, 1, 240)",
            "COALESCE(d.memory_updated_at, d.modified_at) DESC, d.id",
        )
    };
    let total = connection.query_row(
        &format!("SELECT COUNT(*) FROM {from} WHERE {filters}"),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;
    let limit = query.limit.clamp(1, 100);
    values.push(i64::from(limit).into());
    values.push(i64::from(query.offset).into());
    let sql = format!(
        "SELECT d.id, d.kind, d.title, {excerpt}, d.modified_at,
                d.relative_path, d.sha256, d.memory_kind, d.memory_source,
                d.memory_pinned, d.memory_version, d.memory_updated_at,
                d.canonical_record_id
         FROM {from} WHERE {filters} ORDER BY {order} LIMIT ? OFFSET ?"
    );
    let mut statement = connection.prepare(&sql)?;
    let items = statement
        .query_map(params_from_iter(values), |row| {
            let memory_kind = MemoryKind::parse(row.get::<_, String>(7)?)
                .map_err(super::super::to_sql_conversion_error)?;
            let relative_path = row.get::<_, String>(5)?;
            let sha256 = row.get::<_, String>(6)?;
            let source = MemorySource::parse(row.get::<_, String>(8)?)
                .map_err(super::super::to_sql_conversion_error)?;
            let canonical_record_id = row.get::<_, Option<String>>(12)?;
            Ok(MemorySearchHit {
                id: canonical_record_id
                    .as_deref()
                    .map(|record_id| {
                        super::super::portable::portable_projected_memory_id(
                            &query.workspace_id,
                            record_id,
                        )
                    })
                    .unwrap_or(row.get(0)?),
                workspace_id: query.workspace_id.clone(),
                kind: memory_kind,
                title: row.get(2)?,
                excerpt: row.get(3)?,
                source,
                pinned: row.get(9)?,
                version: row.get(10)?,
                updated_at: row.get::<_, Option<i64>>(11)?.unwrap_or(row.get(4)?),
                file_path: Some(relative_path.clone()),
                project_source: Some(ProjectKnowledgeProvenance {
                    project_id: project_id.clone(),
                    relative_path,
                    sha256,
                }),
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

fn search_documents_direct(
    query: &MemoryQuery,
    refresh: &ProjectKnowledgeRefresh,
) -> Result<Page<MemorySearchHit>> {
    let terms = query
        .text
        .split_whitespace()
        .map(|term| term.trim_matches(|ch: char| !ch.is_alphanumeric() && ch != '_'))
        .filter(|term| !term.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let mut matching = refresh
        .documents
        .iter()
        .filter(|document| {
            (query.kinds.is_empty() || query.kinds.contains(&document.memory_kind))
                && (query.sources.is_empty() || query.sources.contains(&document.memory_source))
                && query.updated_after.is_none_or(|updated_after| {
                    document
                        .canonical_updated_at
                        .unwrap_or(document.modified_at)
                        >= updated_after
                })
                && {
                    let haystack = format!("{}\n{}", document.title, document.body).to_lowercase();
                    terms.iter().all(|term| haystack.contains(term))
                }
        })
        .collect::<Vec<_>>();
    matching.sort_by(|left, right| {
        right
            .canonical_updated_at
            .unwrap_or(right.modified_at)
            .cmp(&left.canonical_updated_at.unwrap_or(left.modified_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    let total = matching.len() as u64;
    let limit = query.limit.clamp(1, 100);
    let start = (query.offset as usize).min(matching.len());
    let end = start.saturating_add(limit as usize).min(matching.len());
    let items = matching[start..end]
        .iter()
        .map(|document| MemorySearchHit {
            id: document
                .canonical_record_id
                .as_deref()
                .map(|record_id| {
                    super::super::portable::portable_projected_memory_id(
                        &query.workspace_id,
                        record_id,
                    )
                })
                .unwrap_or_else(|| document.id.clone()),
            workspace_id: query.workspace_id.clone(),
            kind: document.memory_kind,
            title: document.title.clone(),
            excerpt: bounded_chars(&document.body, 240).0,
            source: document.memory_source,
            pinned: document.memory_pinned,
            version: document.canonical_version.unwrap_or(1),
            updated_at: document
                .canonical_updated_at
                .unwrap_or(document.modified_at),
            file_path: Some(document.relative_path.clone()),
            project_source: Some(ProjectKnowledgeProvenance {
                project_id: document.project_id.clone(),
                relative_path: document.relative_path.clone(),
                sha256: document.sha256.clone(),
            }),
        })
        .collect();
    Ok(Page {
        items,
        total,
        limit,
        offset: query.offset,
    })
}
