use kodade_lib::mcp::{self, Cli};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    // The embedded browser is archived (#62): only a development build serves
    // the KödBrowser tools. A public kodade-mcp serves KödMem alone and says
    // so instead of pretending the subcommand exists.
    if args.first().map(String::as_str) == Some("browser") {
        if args.len() != 1 {
            eprintln!("kodade-mcp: browser does not accept additional arguments");
            std::process::exit(2);
        }
        #[cfg(feature = "development-features")]
        {
            if let Err(error) = kodade_lib::browser_mcp::serve().await {
                eprintln!("kodade-mcp: {error}");
                std::process::exit(1);
            }
            return;
        }
        #[cfg(not(feature = "development-features"))]
        {
            eprintln!("kodade-mcp: KödBrowser is unavailable in the public release");
            std::process::exit(2);
        }
    }

    match mcp::parse_cli(args.drain(..)) {
        Ok(Cli::Help) => println!("{}", mcp::HELP),
        Ok(Cli::Serve(config)) => {
            if let Err(error) = mcp::serve(config).await {
                eprintln!("kodade-mcp: {error}");
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("kodade-mcp: {error}\n\n{}", mcp::HELP);
            std::process::exit(2);
        }
    }
}
