use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BROWSER_BRIDGE_FILE: &str = "kodade-browser.json";
pub const BROWSER_BRIDGE_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBridgeDescriptor {
    pub version: u32,
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

impl BrowserBridgeDescriptor {
    pub fn endpoint(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BrowserAgentCommand {
    Navigate {
        project_root: String,
        url: String,
    },
    Snapshot {
        project_root: String,
    },
    Click {
        project_root: String,
        element_ref: String,
    },
    Fill {
        project_root: String,
        element_ref: String,
        text: String,
        #[serde(default)]
        submit: bool,
    },
    Press {
        project_root: String,
        key: String,
    },
}

impl BrowserAgentCommand {
    pub fn project_root(&self) -> &str {
        match self {
            Self::Navigate { project_root, .. }
            | Self::Snapshot { project_root }
            | Self::Click { project_root, .. }
            | Self::Fill { project_root, .. }
            | Self::Press { project_root, .. } => project_root,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct BrowserBridgeReply {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BrowserBridgeReply {
    pub fn success(result: Value) -> Self {
        Self {
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            result: None,
            error: Some(error.into()),
        }
    }
}

pub fn browser_descriptor_path(data_dir: &Path) -> PathBuf {
    data_dir.join(BROWSER_BRIDGE_FILE)
}

pub fn default_browser_descriptor_path() -> Result<PathBuf, String> {
    if let Some(directory) = std::env::var_os("KODADE_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(browser_descriptor_path(Path::new(&directory)));
    }
    crate::app_data::default_app_data_dir().map(|directory| browser_descriptor_path(&directory))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn command_json_keeps_the_requesting_project_and_action() {
        let command = BrowserAgentCommand::Fill {
            project_root: "/work/app".into(),
            element_ref: "kd-3".into(),
            text: "Keith".into(),
            submit: true,
        };
        assert_eq!(
            serde_json::to_value(&command).unwrap(),
            json!({
                "action": "fill",
                "project_root": "/work/app",
                "element_ref": "kd-3",
                "text": "Keith",
                "submit": true
            })
        );
        assert_eq!(command.project_root(), "/work/app");
    }

    #[test]
    fn descriptor_builds_only_a_loopback_endpoint() {
        let descriptor = BrowserBridgeDescriptor {
            version: BROWSER_BRIDGE_VERSION,
            port: 43117,
            token: "secret".into(),
            pid: 42,
        };
        assert_eq!(
            descriptor.endpoint("/command"),
            "http://127.0.0.1:43117/command"
        );
    }

    #[test]
    fn reply_has_exactly_one_outcome() {
        assert_eq!(
            serde_json::to_value(BrowserBridgeReply::success(json!({"ok": true}))).unwrap(),
            json!({"result": {"ok": true}})
        );
        assert_eq!(
            serde_json::to_value(BrowserBridgeReply::failure("not open")).unwrap(),
            json!({"error": "not open"})
        );
    }
}
