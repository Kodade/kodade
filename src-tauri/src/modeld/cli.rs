use std::net::IpAddr;
use std::path::PathBuf;

const MAX_CONTEXT_LENGTH: u32 = 2_097_152;

const DEFAULT_PORT: u16 = 4_470;
const DEFAULT_CONTEXT: u32 = 4_096;

pub enum Cli {
    Serve(ServeConfig),
    Help,
}

pub struct ServeConfig {
    pub host: IpAddr,
    pub port: u16,
    pub model: Option<PathBuf>,
    pub context_length: u32,
}

pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Result<Cli, String> {
    let mut args = args.into_iter();
    let mut host: IpAddr = "127.0.0.1".parse().unwrap();
    let mut port = DEFAULT_PORT;
    let mut model = None;
    let mut context_length = DEFAULT_CONTEXT;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Cli::Help),
            "--host" => {
                let value = args.next().ok_or("--host requires a value")?;
                host = value
                    .parse()
                    .map_err(|_| format!("invalid --host IP address: {value}"))?;
            }
            "--port" => {
                let value = args.next().ok_or("--port requires a value")?;
                port = value
                    .parse()
                    .map_err(|_| format!("invalid --port number: {value}"))?;
            }
            "--model" => {
                model = Some(PathBuf::from(args.next().ok_or("--model requires a path")?));
            }
            "--ctx" => {
                let value = args.next().ok_or("--ctx requires a value")?;
                context_length = value
                    .parse()
                    .map_err(|_| format!("invalid --ctx value: {value}"))?;
                if context_length == 0 {
                    return Err("--ctx must be greater than zero".to_string());
                }
                if context_length > MAX_CONTEXT_LENGTH {
                    return Err(format!("--ctx must not exceed {MAX_CONTEXT_LENGTH} tokens"));
                }
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    if !host.is_loopback() {
        return Err(format!(
            "refusing non-loopback --host {host}; kodade-modeld is a local-only server"
        ));
    }

    Ok(Cli::Serve(ServeConfig {
        host,
        port,
        model,
        context_length,
    }))
}

pub const HELP: &str = "\
kodade-modeld — shared KödLocal inference daemon

USAGE:
    kodade-modeld [--host <ip>] [--port <n>] [--model <path>] [--ctx <tokens>]

FLAGS:
    --host <ip>       bind address (default 127.0.0.1; loopback addresses only)
    --port <n>        bind port (default 4470)
    --model <path>    optional GGUF model to load at startup
    --ctx <tokens>    context length for a startup-loaded model (default 4096)
    -h, --help        print this help";

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_args(args: &[&str]) -> Result<Cli, String> {
        parse(args.iter().map(|value| value.to_string()))
    }

    #[test]
    fn defaults_to_loopback_port_and_context() {
        match parse_args(&[]).unwrap() {
            Cli::Serve(config) => {
                assert!(config.host.is_loopback());
                assert_eq!(config.port, 4_470);
                assert_eq!(config.context_length, 4_096);
                assert!(config.model.is_none());
            }
            Cli::Help => panic!("expected serve config"),
        }
    }

    #[test]
    fn parses_startup_model() {
        match parse_args(&["--model", "/models/qwen.gguf", "--ctx", "8192"]).unwrap() {
            Cli::Serve(config) => {
                assert_eq!(config.model, Some(PathBuf::from("/models/qwen.gguf")));
                assert_eq!(config.context_length, 8_192);
            }
            Cli::Help => panic!("expected serve config"),
        }
    }

    #[test]
    fn rejects_public_binds_and_bad_contexts() {
        let error = parse_args(&["--host", "0.0.0.0"]).err().unwrap();
        assert!(error.contains("refusing non-loopback"));
        assert!(parse_args(&["--ctx", "0"]).is_err());
        assert!(parse_args(&["--ctx", "many"]).is_err());
        assert!(parse_args(&["--ctx", "2097152"]).is_ok());
        let error = parse_args(&["--ctx", "2097153"]).err().unwrap();
        assert!(error.contains("2097152"));
    }
}
