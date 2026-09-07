use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn command_output(program: &str, arguments: &[&str], fallback: &str) -> String {
    Command::new(program)
        .args(arguments)
        .output()
        .ok()
        .filter(|result| result.status.success())
        .and_then(|result| String::from_utf8(result.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rerun-if-env-changed=MONEY_MAP_SOURCE_REVISION");
    for git_path in ["HEAD", "index"] {
        let resolved = command_output("git", &["rev-parse", "--git-path", git_path], "");
        if !resolved.is_empty() { println!("cargo:rerun-if-changed={resolved}"); }
    }
    let revision = std::env::var("MONEY_MAP_SOURCE_REVISION")
        .unwrap_or_else(|_| command_output("git", &["rev-parse", "--short=12", "HEAD"], "unknown"));
    let rustc = command_output("rustc", &["--version"], "unknown");
    let build_epoch = std::env::var("SOURCE_DATE_EPOCH").unwrap_or_else(|_| {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_secs().to_string()).unwrap_or_else(|_| "0".to_string())
    });
    println!("cargo:rustc-env=MONEY_MAP_BUILD_REVISION={revision}");
    println!("cargo:rustc-env=MONEY_MAP_BUILD_EPOCH={build_epoch}");
    println!("cargo:rustc-env=MONEY_MAP_RUSTC_VERSION={rustc}");
    tauri_build::build()
}
