fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next();
    let dir = if first.as_deref() == Some("--daemon") {
        args.next()
    } else {
        first
    };
    if let Err(err) = ronin_daemon::daemon::run_daemon(dir) {
        eprintln!("ronin-daemon error: {err}");
        std::process::exit(1);
    }
}
