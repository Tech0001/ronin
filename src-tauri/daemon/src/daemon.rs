use crate::agent::foreground_agent;
use crate::protocol::{
    DaemonEvent, DaemonInfo, DaemonOp, DaemonRequest, DaemonResponse, RemoteTerminal, StartTerminal,
    TerminalSnapshot, FRAME_LIMIT, PROTOCOL,
};
use crate::screen::TerminalScreen;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use uuid::Uuid;

struct Peer {
    authenticated: bool,
    subscriptions: HashSet<u32>,
    tx: mpsc::Sender<String>,
}

struct Session {
    id: u32,
    pid: u32,
    running: bool,
    agent: Option<String>,
    generation: String,
    seq: u64,
    pending: String,
    screen: TerminalScreen,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Session {
    fn metadata(&self) -> RemoteTerminal {
        let (rows, cols) = self.screen.size();
        RemoteTerminal {
            id: self.id,
            pid: self.pid,
            running: self.running,
            agent: self.agent.clone(),
            generation: self.generation.clone(),
            cols,
            rows,
        }
    }
}

struct DaemonState {
    sessions: HashMap<u32, Session>,
    peers: HashMap<u64, Peer>,
    token: String,
    closing: AtomicBool,
    next_peer_id: AtomicU64,
    log_path: PathBuf,
}

impl DaemonState {
    fn log(&self, msg: &str) {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(file, "[{ts}] {msg}");
        }
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn send_line(tx: &mpsc::Sender<String>, line: String) {
    if line.len() <= FRAME_LIMIT {
        let _ = tx.try_send(line);
    }
}

fn broadcast_state(shared: &Arc<Mutex<DaemonState>>) {
    let (terminals, recipients): (Vec<RemoteTerminal>, Vec<mpsc::Sender<String>>) = {
        let guard = shared.lock().unwrap();
        let terminals = guard.sessions.values().map(Session::metadata).collect();
        let recipients = guard
            .peers
            .values()
            .filter(|p| p.authenticated)
            .map(|p| p.tx.clone())
            .collect();
        (terminals, recipients)
    };
    if recipients.is_empty() {
        return;
    }
    if let Ok(mut line) = serde_json::to_string(&DaemonEvent::State { terminals }) {
        line.push('\n');
        for tx in recipients {
            send_line(&tx, line.clone());
        }
    }
}

fn flush_session(shared: &Arc<Mutex<DaemonState>>, id: u32) {
    let payload: Option<(String, Vec<mpsc::Sender<String>>)> = {
        let mut guard = shared.lock().unwrap();
        let event = {
            let Some(session) = guard.sessions.get_mut(&id) else {
                return;
            };
            if session.pending.is_empty() {
                return;
            }
            session.seq += 1;
            let data = std::mem::take(&mut session.pending);
            DaemonEvent::Output {
                id: session.id,
                generation: session.generation.clone(),
                seq: session.seq,
                data,
            }
        };
        let recipients: Vec<mpsc::Sender<String>> = guard
            .peers
            .values()
            .filter(|p| p.authenticated && p.subscriptions.contains(&id))
            .map(|p| p.tx.clone())
            .collect();
        if recipients.is_empty() {
            None
        } else {
            serde_json::to_string(&event)
                .ok()
                .map(|mut s| {
                    s.push('\n');
                    (s, recipients)
                })
        }
    };
    if let Some((line, recipients)) = payload {
        for tx in recipients {
            send_line(&tx, line.clone());
        }
    }
}

fn kill_session_process(session: &mut Session) {
    if session.pid > 0 {
        unsafe {
            libc::kill(-(session.pid as libc::pid_t), libc::SIGHUP);
            libc::kill(-(session.pid as libc::pid_t), libc::SIGTERM);
        }
    }
    let _ = session.child.kill();
}

/// Decode complete UTF-8 sequences from `carry + chunk`, keeping any incomplete trailing
/// multi-byte sequence in `carry` for the next read so TUI box-drawing glyphs never corrupt.
fn decode_utf8_stream(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    let mut combined = Vec::with_capacity(carry.len() + chunk.len());
    combined.extend_from_slice(carry);
    combined.extend_from_slice(chunk);
    carry.clear();

    let mut out = String::with_capacity(combined.len());
    let mut slice = combined.as_slice();
    loop {
        match std::str::from_utf8(slice) {
            Ok(valid) => {
                out.push_str(valid);
                break;
            }
            Err(err) => {
                let valid_len = err.valid_up_to();
                if valid_len > 0 {
                    out.push_str(std::str::from_utf8(&slice[..valid_len]).unwrap());
                }
                if let Some(error_len) = err.error_len() {
                    out.push('\u{FFFD}');
                    slice = &slice[valid_len + error_len..];
                } else {
                    // Incomplete multi-byte sequence at end of buffer — save for next chunk.
                    carry.extend_from_slice(&slice[valid_len..]);
                    break;
                }
            }
        }
    }
    out
}

fn start_terminal(
    shared: &Arc<Mutex<DaemonState>>,
    req: StartTerminal,
) -> Result<RemoteTerminal, String> {
    if req.id == 0 || req.cwd.is_empty() || !req.shell.starts_with('/') {
        return Err("Invalid terminal definition.".into());
    }
    let meta = fs::metadata(&req.cwd).map_err(|_| "Working directory does not exist.".to_string())?;
    if !meta.is_dir() {
        return Err("Working directory is not a directory.".into());
    }

    {
        let guard = shared.lock().unwrap();
        if let Some(existing) = guard.sessions.get(&req.id) {
            if existing.running {
                return Ok(existing.metadata());
            }
        } else if guard.sessions.len() >= 256 {
            return Err("Terminal service limit reached (256 lanes).".into());
        }
    }

    let cols = req.cols.unwrap_or(80).clamp(2, 1000);
    let rows = req.rows.unwrap_or(24).clamp(2, 500);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = CommandBuilder::new(&req.shell);
    cmd.arg("-il");
    cmd.cwd(&req.cwd);
    cmd.env_clear();
    for (k, v) in &req.env {
        if !k.contains('=')
            && !k.contains('\0')
            && !v.contains('\0')
            && k != "ELECTRON_RUN_AS_NODE"
            && k != "NODE_CHANNEL_FD"
            && k != "NODE_CHANNEL_SERIALIZATION_MODE"
        {
            cmd.env(k, v);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;
    let pid = child.process_id().unwrap_or(0);
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    let generation = Uuid::new_v4().to_string();
    let session = Session {
        id: req.id,
        pid,
        running: true,
        agent: None,
        generation: generation.clone(),
        seq: 0,
        pending: String::new(),
        screen: TerminalScreen::new(rows, cols, 2000),
        master: pair.master,
        writer,
        child,
    };
    let result_meta = session.metadata();

    {
        let mut guard = shared.lock().unwrap();
        guard.sessions.insert(req.id, session);
    }

    let id = req.id;
    let shared_clone = Arc::clone(shared);
    std::thread::Builder::new()
        .name(format!("ronin-pty-{id}"))
        .spawn(move || {
            pty_reader_loop(shared_clone, id, generation, reader);
        })
        .map_err(|e| format!("Failed to spawn PTY reader thread: {e}"))?;

    broadcast_state(shared);
    Ok(result_meta)
}

fn pty_reader_loop(
    shared: Arc<Mutex<DaemonState>>,
    id: u32,
    generation: String,
    mut reader: Box<dyn Read + Send>,
) {
    let mut buf = [0u8; 8192];
    let mut carry = Vec::with_capacity(8);

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let raw = &buf[..n];
                let decoded = decode_utf8_stream(&mut carry, raw);
                let should_flush_now = {
                    let mut guard = shared.lock().unwrap();
                    let has_subscriber = guard
                        .peers
                        .values()
                        .any(|p| p.authenticated && p.subscriptions.contains(&id));
                    let Some(session) = guard.sessions.get_mut(&id) else {
                        break;
                    };
                    if session.generation != generation {
                        break;
                    }
                    let responses = session.screen.process(raw);
                    if !has_subscriber && session.running {
                        for reply in responses {
                            let _ = session.writer.write_all(&reply);
                            let _ = session.writer.flush();
                        }
                    }
                    session.pending.push_str(&decoded);
                    session.pending.len() >= 65536
                };
                if should_flush_now {
                    flush_session(&shared, id);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }

    // Flush any leftover invalid UTF-8 tail
    let tail = if !carry.is_empty() {
        String::from_utf8_lossy(&carry).into_owned()
    } else {
        String::new()
    };

    {
        let mut guard = shared.lock().unwrap();
        if let Some(session) = guard.sessions.get_mut(&id) {
            if session.generation == generation {
                let exit_code = session
                    .child
                    .wait()
                    .map(|status| status.exit_code())
                    .unwrap_or(0);
                session.running = false;
                session.agent = None;
                let msg = format!("{tail}\r\n[Process exited: {exit_code}]\r\n");
                session.screen.process(msg.as_bytes());
                session.pending.push_str(&msg);
            }
        }
    }

    flush_session(&shared, id);
    broadcast_state(&shared);
}

fn acquire_daemon_lock(runtime_dir: &Path) -> Result<File, String> {
    let lock_path = runtime_dir.join("daemon.lock");
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("Failed to open lock file: {e}"))?;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        return Err("Another Ronin daemon instance is already running.".into());
    }
    Ok(file)
}

async fn handle_peer(
    stream: UnixStream,
    shared: Arc<Mutex<DaemonState>>,
    shutdown_tx: mpsc::Sender<()>,
) {
    let (read_half, mut write_half) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<String>(512);
    let peer_id = {
        let mut guard = shared.lock().unwrap();
        let id = guard.next_peer_id.fetch_add(1, Ordering::Relaxed) + 1;
        guard.peers.insert(
            id,
            Peer {
                authenticated: false,
                subscriptions: HashSet::new(),
                tx: tx.clone(),
            },
        );
        id
    };

    let writer_task = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    let auth_deadline = tokio::time::Instant::now() + Duration::from_secs(3);

    loop {
        line.clear();
        let is_authed = {
            let guard = shared.lock().unwrap();
            guard
                .peers
                .get(&peer_id)
                .map(|p| p.authenticated)
                .unwrap_or(false)
        };

        let read_res = if !is_authed {
            match tokio::time::timeout_at(auth_deadline, reader.read_line(&mut line)).await {
                Ok(res) => res,
                Err(_) => break,
            }
        } else {
            reader.read_line(&mut line).await
        };

        let Ok(n) = read_res else { break };
        if n == 0 || line.len() > FRAME_LIMIT {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: DaemonRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(_) => break,
        };

        let (resp, should_close, should_shutdown) = process_request(&shared, peer_id, req);
        if let Ok(mut encoded) = serde_json::to_string(&resp) {
            encoded.push('\n');
            if tx.send(encoded).await.is_err() {
                break;
            }
        }
        if should_shutdown {
            let _ = shutdown_tx.send(()).await;
            break;
        }
        if should_close {
            break;
        }
    }

    {
        let mut guard = shared.lock().unwrap();
        guard.peers.remove(&peer_id);
    }
    drop(tx);
    let _ = writer_task.await;
}

fn process_request(
    shared: &Arc<Mutex<DaemonState>>,
    peer_id: u64,
    req: DaemonRequest,
) -> (DaemonResponse, bool, bool) {
    let rid = req.rid;
    let is_authed = {
        let guard = shared.lock().unwrap();
        guard
            .peers
            .get(&peer_id)
            .map(|p| p.authenticated)
            .unwrap_or(false)
    };

    if !is_authed {
        match req.op {
            DaemonOp::Hello { version, token } => {
                let ok = {
                    let mut guard = shared.lock().unwrap();
                    if version == PROTOCOL && constant_time_eq(&token, &guard.token) {
                        if let Some(peer) = guard.peers.get_mut(&peer_id) {
                            peer.authenticated = true;
                        }
                        true
                    } else {
                        false
                    }
                };
                if ok {
                    let info = DaemonInfo {
                        version: PROTOCOL,
                        pid: std::process::id(),
                    };
                    return (
                        DaemonResponse {
                            rid,
                            value: serde_json::to_value(info).ok(),
                            error: None,
                        },
                        false,
                        false,
                    );
                } else {
                    return (
                        DaemonResponse {
                            rid,
                            value: None,
                            error: Some(
                                "Terminal service authentication or protocol mismatch.".into(),
                            ),
                        },
                        true,
                        false,
                    );
                }
            }
            _ => {
                return (
                    DaemonResponse {
                        rid,
                        value: None,
                        error: Some("Not authenticated.".into()),
                    },
                    true,
                    false,
                );
            }
        }
    }

    match req.op {
        DaemonOp::Hello { .. } => {
            let info = DaemonInfo {
                version: PROTOCOL,
                pid: std::process::id(),
            };
            (
                DaemonResponse {
                    rid,
                    value: serde_json::to_value(info).ok(),
                    error: None,
                },
                false,
                false,
            )
        }
        DaemonOp::List => {
            let guard = shared.lock().unwrap();
            let list: Vec<RemoteTerminal> =
                guard.sessions.values().map(Session::metadata).collect();
            (
                DaemonResponse {
                    rid,
                    value: serde_json::to_value(list).ok(),
                    error: None,
                },
                false,
                false,
            )
        }
        DaemonOp::Start { value } => match start_terminal(shared, value) {
            Ok(meta) => (
                DaemonResponse {
                    rid,
                    value: serde_json::to_value(meta).ok(),
                    error: None,
                },
                false,
                false,
            ),
            Err(err) => (
                DaemonResponse {
                    rid,
                    value: None,
                    error: Some(err),
                },
                false,
                false,
            ),
        },
        DaemonOp::Detach { id } => {
            let mut guard = shared.lock().unwrap();
            if let Some(peer) = guard.peers.get_mut(&peer_id) {
                peer.subscriptions.remove(&id);
            }
            (
                DaemonResponse {
                    rid,
                    value: Some(serde_json::Value::Bool(true)),
                    error: None,
                },
                false,
                false,
            )
        }
        DaemonOp::Attach { id } => {
            // Unsubscribe first, flush any pending data to other peers, then serialize atomically.
            {
                let mut guard = shared.lock().unwrap();
                if let Some(peer) = guard.peers.get_mut(&peer_id) {
                    peer.subscriptions.remove(&id);
                }
            }
            flush_session(shared, id);
            let snapshot_res = {
                let mut guard = shared.lock().unwrap();
                let snap = if let Some(session) = guard.sessions.get_mut(&id) {
                    let meta = session.metadata();
                    let data = session.screen.serialize();
                    Some(TerminalSnapshot {
                        id: meta.id,
                        pid: meta.pid,
                        running: meta.running,
                        agent: meta.agent,
                        generation: meta.generation,
                        cols: meta.cols,
                        rows: meta.rows,
                        seq: session.seq,
                        data,
                    })
                } else {
                    None
                };
                if snap.is_some() {
                    if let Some(peer) = guard.peers.get_mut(&peer_id) {
                        peer.subscriptions.insert(id);
                    }
                }
                snap
            };
            match snapshot_res {
                Some(snap) => (
                    DaemonResponse {
                        rid,
                        value: serde_json::to_value(snap).ok(),
                        error: None,
                    },
                    false,
                    false,
                ),
                None => (
                    DaemonResponse {
                        rid,
                        value: None,
                        error: Some("Unknown terminal.".into()),
                    },
                    false,
                    false,
                ),
            }
        }
        DaemonOp::Write { id, data } => {
            if data.len() > 1_000_000 {
                return (
                    DaemonResponse {
                        rid,
                        value: None,
                        error: Some("Invalid terminal input.".into()),
                    },
                    false,
                    false,
                );
            }
            let res = {
                let mut guard = shared.lock().unwrap();
                match guard.sessions.get_mut(&id) {
                    Some(session) if session.running => session
                        .writer
                        .write_all(data.as_bytes())
                        .and_then(|_| session.writer.flush())
                        .map_err(|e| format!("Failed writing to PTY: {e}")),
                    Some(_) => Err("Terminal has exited.".into()),
                    None => Err("Unknown terminal.".into()),
                }
            };
            match res {
                Ok(()) => (
                    DaemonResponse {
                        rid,
                        value: Some(serde_json::Value::Bool(true)),
                        error: None,
                    },
                    false,
                    false,
                ),
                Err(err) => (
                    DaemonResponse {
                        rid,
                        value: None,
                        error: Some(err),
                    },
                    false,
                    false,
                ),
            }
        }
        DaemonOp::Resize { id, cols, rows } => {
            let cols = cols.clamp(2, 1000);
            let rows = rows.clamp(2, 500);
            let res = {
                let mut guard = shared.lock().unwrap();
                match guard.sessions.get_mut(&id) {
                    Some(session) => {
                        session.screen.resize(rows, cols);
                        if session.running {
                            let _ = session.master.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                        Ok(())
                    }
                    None => Err("Unknown terminal.".into()),
                }
            };
            match res {
                Ok(()) => (
                    DaemonResponse {
                        rid,
                        value: Some(serde_json::Value::Bool(true)),
                        error: None,
                    },
                    false,
                    false,
                ),
                Err(err) => (
                    DaemonResponse {
                        rid,
                        value: None,
                        error: Some(err),
                    },
                    false,
                    false,
                ),
            }
        }
        DaemonOp::Kill { id } => {
            {
                let mut guard = shared.lock().unwrap();
                if let Some(session) = guard.sessions.get_mut(&id) {
                    if session.running {
                        kill_session_process(session);
                    }
                }
            }
            (
                DaemonResponse {
                    rid,
                    value: Some(serde_json::Value::Bool(true)),
                    error: None,
                },
                false,
                false,
            )
        }
        DaemonOp::Shutdown => {
            {
                let mut guard = shared.lock().unwrap();
                guard.closing.store(true, Ordering::SeqCst);
                for session in guard.sessions.values_mut() {
                    if session.running {
                        kill_session_process(session);
                    }
                }
            }
            (
                DaemonResponse {
                    rid,
                    value: Some(serde_json::Value::Bool(true)),
                    error: None,
                },
                true,
                true,
            )
        }
    }
}

pub fn run_daemon(dir_arg: Option<String>) -> Result<(), String> {
    let runtime_dir = PathBuf::from(dir_arg.ok_or("Missing daemon runtime directory.")?);
    unsafe {
        libc::umask(0o077);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }

    let _lock_file = match acquire_daemon_lock(&runtime_dir) {
        Ok(f) => f,
        Err(_) => return Ok(()), // Another daemon already holds the lock.
    };

    let token_path = runtime_dir.join("token");
    let token = fs::read_to_string(&token_path)
        .map_err(|e| format!("Failed to read daemon token: {e}"))?
        .trim()
        .to_string();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid terminal service token.".into());
    }

    let log_path = runtime_dir.join("daemon.log");
    let _ = fs::write(&log_path, "");

    let socket_path = runtime_dir.join("service.sock");
    let _ = fs::remove_file(&socket_path);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| format!("Failed to start daemon runtime: {e}"))?;

    rt.block_on(async move {
        let listener = UnixListener::bind(&socket_path)
            .map_err(|e| format!("Failed to bind daemon socket: {e}"))?;
        let _ = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600));

        let shared = Arc::new(Mutex::new(DaemonState {
            sessions: HashMap::new(),
            peers: HashMap::new(),
            token,
            closing: AtomicBool::new(false),
            next_peer_id: AtomicU64::new(0),
            log_path,
        }));
        shared
            .lock()
            .unwrap()
            .log(&format!("Ronin daemon started (pid={})", std::process::id()));

        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(4);

        // 16ms output flush ticker
        let flush_shared = Arc::clone(&shared);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(16));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let ids: Vec<u32> = {
                    let guard = flush_shared.lock().unwrap();
                    if guard.closing.load(Ordering::Relaxed) {
                        break;
                    }
                    guard
                        .sessions
                        .iter()
                        .filter(|(_, s)| !s.pending.is_empty())
                        .map(|(&id, _)| id)
                        .collect()
                };
                for id in ids {
                    flush_session(&flush_shared, id);
                }
            }
        });

        // 800ms agent detection & idle shutdown ticker
        let poll_shared = Arc::clone(&shared);
        let poll_shutdown = shutdown_tx.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(800));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut idle_ticks = 0u32;
            loop {
                interval.tick().await;
                let (closing, has_peers, running_pids): (bool, bool, Vec<(u32, u32)>) = {
                    let guard = poll_shared.lock().unwrap();
                    (
                        guard.closing.load(Ordering::Relaxed),
                        !guard.peers.is_empty(),
                        guard
                            .sessions
                            .values()
                            .filter(|s| s.running)
                            .map(|s| (s.id, s.pid))
                            .collect(),
                    )
                };
                if closing {
                    break;
                }
                if !has_peers && running_pids.is_empty() {
                    idle_ticks += 1;
                    // Give a freshly-launched daemon ~12s grace before exiting when completely idle.
                    if idle_ticks >= 15 {
                        let _ = poll_shutdown.send(()).await;
                        break;
                    }
                    continue;
                }
                idle_ticks = 0;

                if running_pids.is_empty() {
                    continue;
                }
                let detected: Vec<(u32, Option<String>)> = tokio::task::spawn_blocking(move || {
                    running_pids
                        .into_iter()
                        .map(|(id, pid)| (id, foreground_agent(pid)))
                        .collect()
                })
                .await
                .unwrap_or_default();

                let mut changed = false;
                {
                    let mut guard = poll_shared.lock().unwrap();
                    for (id, agent) in detected {
                        if let Some(session) = guard.sessions.get_mut(&id) {
                            if session.running && session.agent != agent {
                                session.agent = agent;
                                changed = true;
                            }
                        }
                    }
                }
                if changed {
                    broadcast_state(&poll_shared);
                }
            }
        });

        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();

        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        let shared_peer = Arc::clone(&shared);
                        let stx = shutdown_tx.clone();
                        tokio::spawn(handle_peer(stream, shared_peer, stx));
                    }
                }
                _ = shutdown_rx.recv() => {
                    break;
                }
                _ = async {
                    if let Some(ref mut s) = sigterm {
                        s.recv().await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {
                    break;
                }
            }
        }

        // Clean shutdown
        {
            let mut guard = shared.lock().unwrap();
            guard.closing.store(true, Ordering::SeqCst);
            for session in guard.sessions.values_mut() {
                if session.running {
                    kill_session_process(session);
                }
            }
            guard.log("Ronin daemon shutting down.");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = fs::remove_file(&socket_path);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_split_utf8_box_drawing_cleanly() {
        let glyph = "│─╭╮".as_bytes();
        let mut carry = Vec::new();
        let mut combined = String::new();
        for chunk in glyph.chunks(2) {
            combined.push_str(&decode_utf8_stream(&mut carry, chunk));
        }
        assert!(carry.is_empty());
        assert_eq!(combined, "│─╭╮");
    }
}
