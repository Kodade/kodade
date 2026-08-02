use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let project = match (args.next().as_deref(), args.next(), args.next()) {
        (Some("--project"), Some(project), None) => PathBuf::from(project),
        (Some("-h" | "--help"), None, None) => {
            println!("Usage: kodade-tool-host --project <absolute-root>");
            return;
        }
        _ => {
            eprintln!("Usage: kodade-tool-host --project <absolute-root>");
            std::process::exit(2);
        }
    };
    if let Err(error) = kodade_lib::tool_host::run(project) {
        eprintln!("kodade-tool-host: {error}");
        std::process::exit(1);
    }
}
