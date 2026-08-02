// `kodade-modeld` — the shared KödLocal inference daemon entry point. Thin by
// design: CLI parsing and server/engine logic live in src/modeld/.

use kodade_lib::modeld::{self, cli};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(args) {
        Ok(cli::Cli::Help) => println!("{}", cli::HELP),
        Ok(cli::Cli::Serve(config)) => {
            if let Err(error) = modeld::serve(config).await {
                eprintln!("kodade-modeld: {error}");
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("kodade-modeld: {error}\n\n{}", cli::HELP);
            std::process::exit(2);
        }
    }
}
