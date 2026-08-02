use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::pathguard;
use crate::shell::ShellEnvironment;

const MAX_WRITE_BYTES: usize = 1_048_576;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_ARG_COUNT: usize = 32;
const MAX_ARG_BYTES: usize = 1_024;
const MAX_FRAME_BYTES: usize = 256 * 1024;
const MAX_LISTING_ENTRIES: usize = 1_024;
const MAX_LISTING_BYTES: usize = 128 * 1024;

#[derive(Debug)]
enum FrameReadError {
    TooLarge { limit: usize },
    InvalidUtf8,
    Io(std::io::Error),
}

impl std::fmt::Display for FrameReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { limit } => write!(formatter, "frame exceeds the {limit}-byte limit"),
            Self::InvalidUtf8 => formatter.write_str("frame is not valid UTF-8"),
            Self::Io(error) => write!(formatter, "read frame: {error}"),
        }
    }
}

fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<String>, FrameReadError> {
    let mut frame = Vec::new();
    let mut overflow = false;
    loop {
        let (consumed, newline) = {
            let available = reader.fill_buf().map_err(FrameReadError::Io)?;
            if available.is_empty() {
                if overflow {
                    return Err(FrameReadError::TooLarge {
                        limit: MAX_FRAME_BYTES,
                    });
                }
                if frame.is_empty() {
                    return Ok(None);
                }
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                return String::from_utf8(frame)
                    .map(Some)
                    .map_err(|_| FrameReadError::InvalidUtf8);
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let consumed = newline.map_or(available.len(), |index| index + 1);
            let payload = newline.map_or(available, |index| &available[..index]);
            if !overflow {
                if frame.len().saturating_add(payload.len()) > MAX_FRAME_BYTES {
                    overflow = true;
                } else {
                    frame.extend_from_slice(payload);
                }
            }
            (consumed, newline.is_some())
        };
        reader.consume(consumed);
        if !newline {
            continue;
        }
        if overflow {
            return Err(FrameReadError::TooLarge {
                limit: MAX_FRAME_BYTES,
            });
        }
        if frame.last() == Some(&b'\r') {
            frame.pop();
        }
        return String::from_utf8(frame)
            .map(Some)
            .map_err(|_| FrameReadError::InvalidUtf8);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolFrame {
    id: u64,
    cmd: String,
    args: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteArgs {
    path: String,
    contents: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunArgs {
    args: Vec<String>,
}

fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|error| format!("invalid arguments: {error}"))
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.chars().any(|character| character.is_control())
    {
        return Err("path has an invalid length or character".to_string());
    }
    Ok(())
}

fn validate_argv(args: &[String]) -> Result<(), String> {
    if args.len() > MAX_ARG_COUNT
        || args.iter().any(|arg| {
            arg.len() > MAX_ARG_BYTES || arg.chars().any(|character| character.is_control())
        })
    {
        return Err("command arguments exceed the tool transport limits".to_string());
    }
    Ok(())
}

fn utf8_path(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "authorized path is not valid UTF-8".to_string())
}

fn execute(project_root: &Path, cmd: &str, args: Value) -> Result<Value, String> {
    let root = project_root
        .to_str()
        .ok_or_else(|| "project root is not valid UTF-8".to_string())?;
    match cmd {
        "fs_read_file" => {
            let args: PathArgs = parse_args(args)?;
            validate_path(&args.path)?;
            let path = pathguard::confine_document_read(root, &args.path)?;
            serde_json::to_value(crate::fs::read_file(utf8_path(&path)?)?)
                .map_err(|error| format!("serialize file result: {error}"))
        }
        "fs_list_dir" => {
            let args: PathArgs = parse_args(args)?;
            validate_path(&args.path)?;
            let path = pathguard::confine_directory_read(root, &args.path)?;
            serde_json::to_value(crate::fs::list_dir_bounded(
                utf8_path(&path)?,
                MAX_LISTING_ENTRIES,
                MAX_LISTING_BYTES,
            )?)
            .map_err(|error| format!("serialize directory result: {error}"))
        }
        "fs_write_file" => {
            let args: WriteArgs = parse_args(args)?;
            validate_path(&args.path)?;
            if args.contents.len() > MAX_WRITE_BYTES {
                return Err(format!("write exceeds the {MAX_WRITE_BYTES}-byte limit"));
            }
            let candidate = Path::new(&args.path);
            let path = if candidate.exists() {
                pathguard::confine_document_read(root, &args.path)?
            } else {
                pathguard::confine_mutation(root, &args.path)?
            };
            crate::fs::write_file(utf8_path(&path)?, &args.contents)?;
            Ok(Value::Null)
        }
        "run_git" => {
            let args: RunArgs = parse_args(args)?;
            validate_argv(&args.args)?;
            serde_json::to_value(crate::git::run_git(
                &ShellEnvironment::current(),
                project_root,
                args.args,
            )?)
            .map_err(|error| format!("serialize git result: {error}"))
        }
        "run_gh" => {
            let args: RunArgs = parse_args(args)?;
            validate_argv(&args.args)?;
            serde_json::to_value(crate::github::run_gh(
                &ShellEnvironment::current(),
                project_root,
                args.args,
            )?)
            .map_err(|error| format!("serialize GitHub result: {error}"))
        }
        _ => Err(format!("tool command is not allowed: {cmd}")),
    }
}

fn malformed(id: Value, message: impl std::fmt::Display) -> String {
    json!({ "id": id, "ok": false, "error": format!("malformed frame: {message}") }).to_string()
}

fn response(id: Value, result: Result<Value, String>) -> String {
    match result {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }).to_string(),
        Err(error) => json!({ "id": id, "ok": false, "error": error }).to_string(),
    }
}

pub fn handle_line(project_root: &Path, line: &str) -> String {
    let parsed: ToolFrame = match serde_json::from_str(line) {
        Ok(frame) => frame,
        Err(error) => return malformed(Value::Null, error),
    };
    response(
        json!(parsed.id),
        execute(project_root, &parsed.cmd, parsed.args),
    )
}

fn serve<R: BufRead, W: Write>(
    project_root: &Path,
    reader: &mut R,
    writer: &mut W,
) -> Result<(), String> {
    loop {
        let output = match read_frame(reader) {
            Ok(Some(line)) => handle_line(project_root, &line),
            Ok(None) => return Ok(()),
            Err(error @ FrameReadError::TooLarge { .. })
            | Err(error @ FrameReadError::InvalidUtf8) => malformed(Value::Null, error),
            Err(FrameReadError::Io(error)) => return Err(format!("read tool request: {error}")),
        };
        writer
            .write_all(output.as_bytes())
            .and_then(|_| writer.write_all(b"\n"))
            .and_then(|_| writer.flush())
            .map_err(|error| format!("write tool response: {error}"))?;
    }
}

pub fn run(project_root: PathBuf) -> Result<(), String> {
    if !project_root.is_absolute() {
        return Err(format!(
            "--project must be an absolute path: {}",
            project_root.display()
        ));
    }
    let project_root = std::fs::canonicalize(&project_root)
        .map_err(|error| format!("resolve project root {}: {error}", project_root.display()))?;
    if !project_root.is_dir() {
        return Err(format!(
            "project root is not a directory: {}",
            project_root.display()
        ));
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    serve(&project_root, &mut reader, &mut writer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufReader, Cursor};

    fn response(root: &Path, frame: Value) -> Value {
        serde_json::from_str(&handle_line(root, &frame.to_string())).unwrap()
    }

    #[test]
    fn commands_outside_the_agent_tool_contract_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        for cmd in ["pty_spawn", "memory_context", "config_read"] {
            let result = response(root.path(), json!({ "id": 7, "cmd": cmd, "args": {} }));
            assert_eq!(result["id"], json!(7));
            assert_eq!(result["ok"], json!(false));
            assert!(result["error"].as_str().unwrap().contains("not allowed"));
        }
    }

    #[test]
    fn malformed_and_oversized_frames_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let malformed: Value = serde_json::from_str(&handle_line(root.path(), "not-json")).unwrap();
        assert_eq!(malformed["ok"], json!(false));
        assert!(malformed["error"]
            .as_str()
            .unwrap()
            .contains("malformed frame"));

        let mut input = vec![b'x'; MAX_FRAME_BYTES + 1];
        input.extend_from_slice(b"\n{\"id\":9,\"cmd\":\"pty_spawn\",\"args\":{}}\n");
        let mut reader = BufReader::with_capacity(31, Cursor::new(input));
        let mut output = Vec::new();
        serve(root.path(), &mut reader, &mut output).unwrap();
        let responses: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 2);
        assert!(responses[0]["error"]
            .as_str()
            .unwrap()
            .contains("frame exceeds"));
        assert_eq!(responses[1]["id"], json!(9));
    }

    #[test]
    fn reads_and_writes_remain_confined_to_the_fixed_project() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let inside = project.join("inside.txt");
        let outside = root.path().join("outside.txt");
        std::fs::write(&inside, "inside").unwrap();
        std::fs::write(&outside, "outside").unwrap();

        let allowed = response(
            &project,
            json!({ "id": 1, "cmd": "fs_read_file", "args": { "path": inside } }),
        );
        assert_eq!(allowed["ok"], json!(true));
        assert_eq!(allowed["result"]["kind"], json!("text"));

        let escaped = response(
            &project,
            json!({ "id": 2, "cmd": "fs_write_file", "args": { "path": outside, "contents": "changed" } }),
        );
        assert_eq!(escaped["ok"], json!(false));
        assert_eq!(
            std::fs::read_to_string(root.path().join("outside.txt")).unwrap(),
            "outside"
        );
    }
}
