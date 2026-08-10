pub mod agent;
pub mod app_data;
#[cfg(feature = "voice")]
mod browser;
#[cfg(feature = "voice")]
mod browser_bridge;
pub mod browser_mcp;
pub mod browser_protocol;
#[cfg(feature = "voice")]
mod commands;
pub mod config;
pub mod configguard;
mod desktop;
pub mod detect;
pub mod document;
#[cfg(feature = "voice")]
pub mod download;
pub mod exec;
pub mod fs;
pub mod git;
pub mod github;
pub mod license;
pub mod mcp;
pub mod memory;
pub mod modeld;
pub mod pathguard;
pub mod process_tree;
pub mod pty;
pub mod shell;
pub mod ssh;
pub mod storage;
pub mod tool_host;
#[cfg(feature = "voice")]
pub mod vox;

#[cfg(feature = "voice")]
use std::time::Instant;

#[cfg(feature = "voice")]
use agent::AgentManager;
#[cfg(feature = "voice")]
use commands::{ModeldManager, WatchManager};
#[cfg(feature = "voice")]
use pty::PtyManager;
#[cfg(feature = "voice")]
use tauri::{Manager, RunEvent};
#[cfg(feature = "voice")]
use vox::VoxManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(feature = "voice")]
pub fn run() {
    // Startup budget: the app should be interactive in well under a second.
    // We keep the Rust core work at boot trivial (two in-memory managers; all
    // provider detection / fs work is lazy, driven by frontend commands), so
    // nothing synchronous blocks the window. This stamp lets a release build
    // log "core ready in Nms" (spawn → RunEvent::Ready) to keep us honest.
    let boot = Instant::now();

    tauri::Builder::default()
        .register_uri_scheme_protocol("kodade-doc", |ctx, request| {
            let root = ctx.app_handle().state::<WatchManager>().active_root();
            document::serve(root.as_deref(), &request)
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::new())
        .manage(AgentManager::new())
        .manage(WatchManager::new())
        .manage(ModeldManager::new())
        .manage(VoxManager::new())
        .setup(|app| {
            let (readiness, ready) = browser_bridge::readiness();
            app.manage(readiness);
            match browser_bridge::start(app.handle().clone(), ready) {
                Ok(manager) => {
                    app.manage(manager);
                }
                Err(error) => {
                    // The browser MCP server will expose no tools without a
                    // healthy descriptor. Keep the rest of Kodade usable and
                    // surface the unavailable state to agents instead.
                    eprintln!("kodade: internal browser agent bridge unavailable: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_foreground,
            commands::agent_start,
            commands::agent_send,
            commands::agent_cancel,
            commands::local_modeld_status,
            commands::local_modeld_start,
            commands::local_modeld_stop,
            commands::local_download_model,
            commands::local_model_path,
            commands::local_validate_model,
            commands::storage_read,
            commands::storage_write,
            commands::storage_read_doc,
            commands::storage_write_doc,
            commands::storage_delete_doc,
            commands::fs_is_dir,
            commands::fs_canonicalize,
            commands::fs_list_dir,
            commands::fs_read_file,
            commands::fs_write_file,
            commands::fs_create_file,
            commands::fs_create_dir,
            commands::fs_rename,
            commands::fs_trash,
            commands::fs_reveal,
            commands::open_url,
            commands::fs_watch,
            commands::fs_unwatch,
            commands::shell_name,
            commands::detect_provider,
            commands::run_gh,
            commands::run_git,
            commands::config_scan,
            commands::config_read,
            commands::config_env,
            commands::config_rename,
            commands::config_write,
            commands::config_backup,
            commands::config_restore,
            commands::kodskills_pack_read,
            commands::config_dir_snapshot,
            commands::config_install_dir,
            commands::config_remove_dir,
            commands::config_restore_dir,
            commands::project_skill_pick,
            commands::license_token_write,
            memory::commands::memory_register_workspace,
            memory::commands::memory_resolve_workspace,
            memory::commands::memory_list_workspaces,
            memory::commands::memory_relink_workspace,
            memory::commands::memory_projects_vault,
            memory::commands::memory_register_projects_vault,
            memory::commands::memory_workspace_project_mapping,
            memory::commands::memory_map_workspace_to_project,
            memory::commands::memory_project_workspace_mappings,
            memory::commands::memory_preview_project_scaffold,
            memory::commands::memory_apply_project_scaffold,
            memory::commands::memory_preview_legacy_migration,
            memory::commands::memory_apply_legacy_migration,
            memory::commands::memory_rollback_legacy_migration,
            memory::commands::memory_open_project_in_obsidian,
            memory::commands::memory_context,
            memory::commands::memory_search,
            memory::commands::memory_get,
            memory::commands::memory_list_deleted,
            memory::commands::memory_remember,
            memory::commands::memory_revise,
            memory::commands::memory_forget,
            memory::commands::memory_restore,
            memory::commands::memory_checkpoint,
            memory::commands::memory_search_checkpoints,
            memory::commands::memory_working_status,
            memory::commands::memory_activate_working,
            memory::commands::memory_sync_working,
            memory::commands::memory_observe_commit,
            memory::commands::memory_audit,
            memory::commands::memory_set_retention,
            memory::commands::memory_run_retention,
            memory::commands::memory_drain_retention,
            memory::commands::memory_export_to_directory,
            memory::commands::memory_purge_workspace,
            memory::commands::memory_record_activity,
            memory::commands::memory_database_path,
            memory::commands::memory_mcp_binary_path,
            commands::ssh_detect,
            commands::ssh_config_read,
            commands::ssh_list_dir,
            commands::ssh_exec,
            browser::browser_create,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_set_bounds,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_destroy,
            browser_bridge::browser_agent_ready,
            vox::vox_init,
            vox::vox_start,
            vox::vox_stop,
            vox::vox_cancel,
            vox::vox_teardown,
            vox::vox_download_model,
            vox::vox_list_input_devices,
            commands::open_microphone_privacy_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building kodade")
        .run(move |app, event| {
            // Kill every live PTY on the way out so no shells/child processes
            // are left orphaned. ExitRequested is the primary path — it fires
            // for Cmd+Q, the app-menu Quit, and (non-macOS) last-window-close.
            // Exit is the final safety net: whatever tears down the event loop,
            // kill_all still runs. kill_all is idempotent, so running twice
            // (already-dead sessions are a no-op) is safe.
            match event {
                // First point the app is up and idle — log time-to-ready.
                RunEvent::Ready => {
                    println!("kodade: core ready in {}ms", boot.elapsed().as_millis());
                }
                RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                    app.state::<PtyManager>().kill_all();
                    // KödChat runs are children of the app too — a headless
                    // agent must not outlive the window that started it.
                    app.state::<AgentManager>().cancel_all();
                }
                _ => {}
            }
        });
}
