use std::path::PathBuf;
use std::time::Duration;

use reqwest::blocking::Client;
use rmcp::handler::server::common::schema_for_input;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ErrorData, Implementation,
    ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerInfo, Tool,
    ToolAnnotations,
};
use rmcp::schemars::{self, JsonSchema};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ServerHandler, ServiceExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::browser_protocol::{
    default_browser_descriptor_path, BrowserAgentCommand, BrowserBridgeDescriptor,
    BrowserBridgeReply, BROWSER_BRIDGE_VERSION,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Clone)]
pub struct BrowserMcp {
    descriptor_path: PathBuf,
    project_root: String,
}

impl BrowserMcp {
    pub fn discover() -> Result<Self, String> {
        let project_root = std::env::current_dir()
            .map_err(|error| format!("cannot resolve the agent working directory: {error}"))?
            .to_string_lossy()
            .to_string();
        Ok(Self {
            descriptor_path: default_browser_descriptor_path()?,
            project_root,
        })
    }

    #[cfg(test)]
    fn new(descriptor_path: PathBuf, project_root: impl Into<String>) -> Self {
        Self {
            descriptor_path,
            project_root: project_root.into(),
        }
    }

    fn descriptor(&self) -> Result<BrowserBridgeDescriptor, String> {
        let bytes = std::fs::read(&self.descriptor_path).map_err(|_| {
            "Kodade's internal browser is unavailable; keep the Kodade desktop app open".to_string()
        })?;
        let descriptor: BrowserBridgeDescriptor = serde_json::from_slice(&bytes)
            .map_err(|_| "Kodade's internal browser connection file is invalid".to_string())?;
        if descriptor.version != BROWSER_BRIDGE_VERSION || descriptor.token.is_empty() {
            return Err("Kodade's internal browser connection is incompatible".into());
        }
        Ok(descriptor)
    }

    fn client(timeout: Duration) -> Result<Client, String> {
        Client::builder()
            .connect_timeout(timeout)
            .timeout(timeout)
            .build()
            .map_err(|error| format!("cannot initialize Kodade browser client: {error}"))
    }

    fn available(&self) -> bool {
        let Ok(descriptor) = self.descriptor() else {
            return false;
        };
        let Ok(client) = Self::client(HEALTH_TIMEOUT) else {
            return false;
        };
        client
            .get(descriptor.endpoint("/health"))
            .bearer_auth(&descriptor.token)
            .send()
            .is_ok_and(|response| response.status().is_success())
    }

    fn request(&self, command: BrowserAgentCommand) -> Result<Value, String> {
        let descriptor = self.descriptor()?;
        let response = Self::client(REQUEST_TIMEOUT)?
            .post(descriptor.endpoint("/command"))
            .bearer_auth(&descriptor.token)
            .json(&command)
            .send()
            .map_err(|error| format!("Kodade's internal browser did not respond: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Kodade's internal browser rejected the request ({})",
                response.status()
            ));
        }
        let reply: BrowserBridgeReply = response
            .json()
            .map_err(|error| format!("Kodade's internal browser returned invalid data: {error}"))?;
        match (reply.result, reply.error) {
            (Some(result), None) => Ok(result),
            (None, Some(error)) => Err(error),
            _ => Err("Kodade's internal browser returned an invalid outcome".into()),
        }
    }

    fn tools(&self) -> Vec<Tool> {
        if !self.available() {
            return Vec::new();
        }
        vec![
            tool::<NavigateParams>(
                "browser_navigate",
                "Navigate Kodade's visible internal browser. Use this for every unqualified browser request; do not open Chrome unless the user explicitly requests Chrome.",
                false,
                false,
                true,
            ),
            tool::<SnapshotParams>(
                "browser_snapshot",
                "Inspect the current page in Kodade's visible internal browser and return its text plus stable element refs.",
                true,
                false,
                true,
            ),
            tool::<ClickParams>(
                "browser_click",
                "Click an element ref from browser_snapshot in Kodade's visible internal browser.",
                false,
                false,
                false,
            ),
            tool::<FillParams>(
                "browser_fill",
                "Fill an input element ref from browser_snapshot in Kodade's visible internal browser.",
                false,
                false,
                false,
            ),
            tool::<PressParams>(
                "browser_press",
                "Press a key in Kodade's visible internal browser.",
                false,
                false,
                false,
            ),
        ]
    }

    fn call_tool_sync(&self, request: CallToolRequestParams) -> Result<CallToolResult, ErrorData> {
        if !self.available() {
            return Ok(tool_error(
                "browser_unavailable",
                "Kodade's internal browser is unavailable; keep the Kodade desktop app open. No external browser was opened.",
            ));
        }
        let arguments = request.arguments.unwrap_or_default();
        let command = match request.name.as_ref() {
            "browser_navigate" => {
                let params = parse_arguments::<NavigateParams>(arguments)?;
                BrowserAgentCommand::Navigate {
                    project_root: self.project_root.clone(),
                    url: params.url,
                }
            }
            "browser_snapshot" => {
                let _ = parse_arguments::<SnapshotParams>(arguments)?;
                BrowserAgentCommand::Snapshot {
                    project_root: self.project_root.clone(),
                }
            }
            "browser_click" => {
                let params = parse_arguments::<ClickParams>(arguments)?;
                BrowserAgentCommand::Click {
                    project_root: self.project_root.clone(),
                    element_ref: params.element_ref,
                }
            }
            "browser_fill" => {
                let params = parse_arguments::<FillParams>(arguments)?;
                BrowserAgentCommand::Fill {
                    project_root: self.project_root.clone(),
                    element_ref: params.element_ref,
                    text: params.text,
                    submit: params.submit,
                }
            }
            "browser_press" => {
                let params = parse_arguments::<PressParams>(arguments)?;
                BrowserAgentCommand::Press {
                    project_root: self.project_root.clone(),
                    key: params.key,
                }
            }
            name => {
                return Ok(tool_error(
                    "unknown_tool",
                    &format!("unknown Kodade browser tool: {name}"),
                ));
            }
        };
        Ok(match self.request(command) {
            Ok(result) => CallToolResult::structured(result),
            Err(error) => tool_error("browser_request_failed", &error),
        })
    }
}

fn tool<T: JsonSchema + 'static>(
    name: &'static str,
    description: &'static str,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
) -> Tool {
    Tool::new(
        name,
        description,
        schema_for_input::<T>().expect("browser MCP tool parameter schema is an object"),
    )
    .with_annotations(
        ToolAnnotations::new()
            .read_only(read_only)
            .destructive(destructive)
            .idempotent(idempotent)
            .open_world(true),
    )
}

fn parse_arguments<T: DeserializeOwned>(
    arguments: serde_json::Map<String, Value>,
) -> Result<T, ErrorData> {
    serde_json::from_value(Value::Object(arguments)).map_err(|error| {
        ErrorData::invalid_params(
            format!("invalid browser tool arguments: {error}"),
            Some(json!({ "type": "invalid_arguments" })),
        )
    })
}

fn tool_error(kind: &str, message: &str) -> CallToolResult {
    CallToolResult::structured_error(json!({ "type": kind, "message": message }))
}

#[derive(Debug, Deserialize, JsonSchema)]
struct NavigateParams {
    url: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
struct SnapshotParams {}

#[derive(Debug, Deserialize, JsonSchema)]
struct ClickParams {
    #[serde(rename = "ref")]
    #[schemars(rename = "ref")]
    element_ref: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct FillParams {
    #[serde(rename = "ref")]
    #[schemars(rename = "ref")]
    element_ref: String,
    text: String,
    #[serde(default)]
    submit: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct PressParams {
    key: String,
}

impl ServerHandler for BrowserMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
            .with_server_info(
                Implementation::new("kodade-browser", env!("CARGO_PKG_VERSION"))
                    .with_title("KödBrowser")
                    .with_description("The visible browser inside Kodade"),
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let server = self.clone();
        let tools = tokio::task::spawn_blocking(move || server.tools())
            .await
            .map_err(|error| {
                ErrorData::internal_error(
                    format!("KödBrowser discovery worker failed: {error}"),
                    None,
                )
            })?;
        let result = ListToolsResult::with_all_items(tools);
        Ok(if uses_cache_metadata(&context) {
            result.with_ttl_ms(0).with_cache_scope(CacheScope::Private)
        } else {
            result
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let server = self.clone();
        tokio::task::spawn_blocking(move || server.call_tool_sync(request))
            .await
            .map_err(|error| {
                ErrorData::internal_error(
                    format!("KödBrowser request worker failed: {error}"),
                    None,
                )
            })?
            .map(Into::into)
    }
}

fn uses_cache_metadata(context: &RequestContext<RoleServer>) -> bool {
    context
        .protocol_version()
        .is_some_and(|version| version.as_str() >= ProtocolVersion::V_2026_07_28.as_str())
}

pub async fn serve() -> Result<(), String> {
    let service = BrowserMcp::discover()?
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|error| error.to_string())?;
    service.waiting().await.map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn fixture(reply: &'static str) -> (PathBuf, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let directory = tempfile::tempdir().unwrap().keep();
        let path = directory.join("browser.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&BrowserBridgeDescriptor {
                version: BROWSER_BRIDGE_VERSION,
                port,
                token: "capability".into(),
                pid: 1,
            })
            .unwrap(),
        )
        .unwrap();
        let handle = thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let mut stream = stream.unwrap();
                let mut request = vec![0; 8 * 1024];
                let bytes = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..bytes]);
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer capability"));
                let body = if request.starts_with("GET /health") {
                    r#"{"ok":true}"#
                } else {
                    reply
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (path, handle)
    }

    #[test]
    fn exposes_no_tools_when_the_desktop_bridge_is_absent() {
        let server = BrowserMcp::new(PathBuf::from("/missing/browser.json"), "/work/app");
        assert!(server.tools().is_empty());
    }

    #[test]
    fn exposes_the_internal_browser_contract_when_kodade_is_running() {
        let (path, handle) = fixture(r#"{"result":{}}"#);
        let server = BrowserMcp::new(path, "/work/app");
        assert_eq!(
            server
                .tools()
                .into_iter()
                .map(|tool| tool.name.to_string())
                .collect::<Vec<_>>(),
            [
                "browser_navigate",
                "browser_snapshot",
                "browser_click",
                "browser_fill",
                "browser_press",
            ]
        );
        handle.join().unwrap();
    }

    #[test]
    fn forwards_the_working_directory_and_bearer_capability() {
        let (path, handle) = fixture(r#"{"result":{"url":"https://example.com/"}}"#);
        let server = BrowserMcp::new(path, "/work/app");
        let result = server
            .request(BrowserAgentCommand::Navigate {
                project_root: "/work/app".into(),
                url: "https://example.com".into(),
            })
            .unwrap();
        assert_eq!(result, json!({"url": "https://example.com/"}));
        handle.join().unwrap();
    }
}
