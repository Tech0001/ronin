use ronin_daemon::protocol::{
    DaemonEvent, DaemonInfo, DaemonMessage, DaemonOp, DaemonRequest, RemoteTerminal, StartTerminal,
    TerminalSnapshot, FRAME_LIMIT, PROTOCOL,
};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use tokio::net::UnixStream;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use tokio::net::TcpStream;

pub fn runtime_directory() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        // Keep Unix socket path short (<104 bytes limit on macOS).
        let uid = unsafe { libc::getuid() };
        return PathBuf::from(format!("/tmp/ronin-tty-{uid}"));
    }
    #[cfg(target_os = "linux")]
    {
        let uid = unsafe { libc::getuid() };
        if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
            let p = PathBuf::from(xdg).join("ronin-tty");
            if p.parent().map(|parent| parent.exists()).unwrap_or(false) {
                return p;
            }
        }
        return PathBuf::from(format!("/tmp/ronin-tty-{uid}"));
    }
    #[cfg(windows)]
    {
        return dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("ronin-tty");
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        std::env::temp_dir().join("ronin-tty")
    }
}

fn generate_token_64_hex() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn prepare_runtime_dir(dir: &PathBuf) -> Result<String, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed creating runtime dir: {e}"))?;

    #[cfg(unix)]
    {
        let uid = unsafe { libc::getuid() };
        let meta =
            fs::symlink_metadata(dir).map_err(|e| format!("Failed stat runtime dir: {e}"))?;
        if !meta.is_dir() || meta.file_type().is_symlink() || meta.uid() != uid {
            return Err("Unsafe terminal service runtime directory.".into());
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed chmod runtime dir: {e}"))?;
    }

    let token_path = dir.join("token");
    if !token_path.exists() {
        let candidate = dir.join(format!("token-{}", Uuid::new_v4().simple()));
        let token_value = generate_token_64_hex();
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut f = opts
            .open(&candidate)
            .map_err(|e| format!("Failed creating temp token: {e}"))?;
        f.write_all(token_value.as_bytes())
            .map_err(|e| format!("Failed writing token: {e}"))?;
        drop(f);
        let _ = fs::hard_link(&candidate, &token_path);
        let _ = fs::remove_file(&candidate);
    }

    #[cfg(unix)]
    {
        let uid = unsafe { libc::getuid() };
        let tmeta =
            fs::symlink_metadata(&token_path).map_err(|e| format!("Failed stat token file: {e}"))?;
        if !tmeta.is_file()
            || tmeta.file_type().is_symlink()
            || tmeta.uid() != uid
            || (tmeta.mode() & 0o077) != 0
        {
            return Err("Unsafe terminal service token file.".into());
        }
    }

    let token = fs::read_to_string(&token_path)
        .map_err(|e| format!("Failed reading token: {e}"))?
        .trim()
        .to_string();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid terminal service token.".into());
    }
    Ok(token)
}

fn resolve_daemon_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let bin_name = format!("ronin-daemon{}", std::env::consts::EXE_SUFFIX);
    let sibling = exe.with_file_name(&bin_name);
    if sibling.is_file() {
        return Ok(sibling);
    }
    if let Some(home) = dirs::home_dir() {
        let local = home.join(".local/bin").join(&bin_name);
        if local.is_file() {
            return Ok(local);
        }
    }
    Err(format!(
        "{bin_name} binary not found next to {}",
        exe.display()
    ))
}

fn spawn_detached_daemon(dir: &PathBuf) -> Result<(), String> {
    let exe = resolve_daemon_binary()?;
    let dir_str = dir.to_string_lossy().to_string();

    #[cfg(target_os = "linux")]
    {
        // Prefer launching the daemon inside its own systemd user scope so GUI crashes
        // or OOM kills in another scope cannot take down running agent terminals.
        let unit = format!("ronin-daemon-{}", &Uuid::new_v4().simple().to_string()[..8]);
        let mut systemd_cmd = Command::new("systemd-run");
        systemd_cmd
            .args([
                "--user",
                "--scope",
                "--quiet",
                "--collect",
                &format!("--unit={unit}"),
                "--",
            ])
            .arg(&exe)
            .arg("--daemon")
            .arg(&dir_str)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .current_dir(std::env::temp_dir());
        unsafe {
            systemd_cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        if let Ok(mut child) = systemd_cmd.spawn() {
            std::thread::sleep(Duration::from_millis(40));
            match child.try_wait() {
                Ok(Some(status)) if !status.success() => {}
                _ => {
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return Ok(());
                }
            }
        }
    }

    let mut cmd = Command::new(&exe);
    cmd.arg("--daemon")
        .arg(&dir_str)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir(std::env::temp_dir());

    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    #[cfg(windows)]
    {
        // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW
        cmd.creation_flags(0x0000_0200 | 0x0000_0008 | 0x0800_0000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed spawning daemon: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(unix)]
async fn connect_transport(
    dir: &PathBuf,
) -> Result<
    (
        Box<dyn AsyncRead + Unpin + Send>,
        Box<dyn AsyncWrite + Unpin + Send>,
    ),
    String,
> {
    let stream = UnixStream::connect(dir.join("service.sock"))
        .await
        .map_err(|e| e.to_string())?;
    let (r, w) = stream.into_split();
    Ok((Box::new(r), Box::new(w)))
}

#[cfg(windows)]
async fn connect_transport(
    dir: &PathBuf,
) -> Result<
    (
        Box<dyn AsyncRead + Unpin + Send>,
        Box<dyn AsyncWrite + Unpin + Send>,
    ),
    String,
> {
    let port_text = fs::read_to_string(dir.join("port")).map_err(|e| e.to_string())?;
    let port: u16 = port_text
        .trim()
        .parse()
        .map_err(|_| "Invalid daemon port".to_string())?;
    let stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|e| e.to_string())?;
    let (r, w) = stream.into_split();
    Ok((Box::new(r), Box::new(w)))
}

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>>;

struct Connection {
    writer: mpsc::Sender<String>,
    pending: PendingMap,
    daemon_pid: u32,
}

#[derive(Clone)]
pub struct DaemonClient {
    runtime_dir: PathBuf,
    app: AppHandle,
    conn: Arc<Mutex<Option<Connection>>>,
    connect_lock: Arc<AsyncMutex<()>>,
    counter: Arc<AtomicU64>,
    reconnecting: Arc<AtomicBool>,
    known_terminals: Arc<Mutex<HashMap<u32, RemoteTerminal>>>,
}

impl DaemonClient {
    pub fn new(app: AppHandle) -> Self {
        Self {
            runtime_dir: runtime_directory(),
            app,
            conn: Arc::new(Mutex::new(None)),
            connect_lock: Arc::new(AsyncMutex::new(())),
            counter: Arc::new(AtomicU64::new(1)),
            reconnecting: Arc::new(AtomicBool::new(false)),
            known_terminals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn daemon_pid(&self) -> Option<u32> {
        self.conn.lock().unwrap().as_ref().map(|c| c.daemon_pid)
    }

    pub fn is_connected(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }

    pub fn known_pid(&self, id: u32) -> Option<u32> {
        self.known_terminals
            .lock()
            .unwrap()
            .get(&id)
            .filter(|t| t.running)
            .map(|t| t.pid)
    }

    pub fn runtime_dir_string(&self) -> String {
        self.runtime_dir.display().to_string()
    }

    pub async fn ensure_connected(&self) -> Result<(), String> {
        if self.is_connected() {
            return Ok(());
        }
        let _guard = self.connect_lock.lock().await;
        if self.is_connected() {
            return Ok(());
        }

        let token = prepare_runtime_dir(&self.runtime_dir)?;

        let (read_half, mut write_half) = match connect_transport(&self.runtime_dir).await {
            Ok(pair) => pair,
            Err(_) => {
                spawn_detached_daemon(&self.runtime_dir)?;
                let mut connected_pair = None;
                for i in 0..60 {
                    tokio::time::sleep(Duration::from_millis(80)).await;
                    if let Ok(pair) = connect_transport(&self.runtime_dir).await {
                        connected_pair = Some(pair);
                        break;
                    }
                    if i == 15 || i == 35 {
                        let _ = spawn_detached_daemon(&self.runtime_dir);
                    }
                }
                connected_pair.ok_or_else(|| {
                    "Background terminal service did not start. Existing sessions were not stopped."
                        .to_string()
                })?
            }
        };

        let (tx, mut rx) = mpsc::channel::<String>(512);
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if write_half.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        let pending_reader = Arc::clone(&pending);
        let conn_slot = Arc::clone(&self.conn);
        let app_handle = self.app.clone();
        let known = Arc::clone(&self.known_terminals);
        let client_for_reconnect = self.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) if n > FRAME_LIMIT => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Ok(msg) = serde_json::from_str::<DaemonMessage>(trimmed) {
                            match msg {
                                DaemonMessage::Event(ev) => match ev {
                                    DaemonEvent::State { terminals } => {
                                        {
                                            let mut map = known.lock().unwrap();
                                            map.clear();
                                            for t in &terminals {
                                                map.insert(t.id, t.clone());
                                            }
                                        }
                                        let _ = app_handle.emit("daemon:state", &terminals);
                                    }
                                    DaemonEvent::Output {
                                        id,
                                        generation,
                                        seq,
                                        data,
                                    } => {
                                        let _ = app_handle.emit(
                                            "daemon:output",
                                            serde_json::json!({
                                                "id": id,
                                                "generation": generation,
                                                "seq": seq,
                                                "data": data,
                                            }),
                                        );
                                    }
                                },
                                DaemonMessage::Response(resp) => {
                                    let waiter = pending_reader.lock().unwrap().remove(&resp.rid);
                                    if let Some(sender) = waiter {
                                        if let Some(err) = resp.error {
                                            let _ = sender.send(Err(err));
                                        } else {
                                            let _ = sender.send(Ok(resp
                                                .value
                                                .unwrap_or(serde_json::Value::Null)));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            let was_connected = conn_slot.lock().unwrap().take().is_some();
            let waiters: Vec<_> = pending_reader
                .lock()
                .unwrap()
                .drain()
                .map(|(_, s)| s)
                .collect();
            for sender in waiters {
                let _ = sender.send(Err(
                    "Terminal connection lost; input was not retried.".into()
                ));
            }
            if was_connected {
                let _ = app_handle.emit("daemon:connection", "reconnecting");
                client_for_reconnect.schedule_reconnect();
            }
        });

        let rid = self.counter.fetch_add(1, Ordering::Relaxed);
        let (resp_tx, resp_rx) = oneshot::channel();
        pending.lock().unwrap().insert(rid, resp_tx);
        let hello_req = DaemonRequest {
            rid,
            op: DaemonOp::Hello {
                version: PROTOCOL,
                token,
            },
        };
        let mut encoded = serde_json::to_string(&hello_req)
            .map_err(|e| format!("Serialize hello failed: {e}"))?;
        encoded.push('\n');
        tx.send(encoded)
            .await
            .map_err(|_| "Failed sending hello to daemon.".to_string())?;

        let hello_val = tokio::time::timeout(Duration::from_secs(5), resp_rx)
            .await
            .map_err(|_| "Daemon handshake timed out.".to_string())?
            .map_err(|_| "Daemon closed during handshake.".to_string())??;

        let info: DaemonInfo = serde_json::from_value(hello_val)
            .map_err(|e| format!("Invalid daemon handshake response: {e}"))?;

        *self.conn.lock().unwrap() = Some(Connection {
            writer: tx,
            pending,
            daemon_pid: info.pid,
        });
        let _ = self.app.emit("daemon:connection", "connected");
        Ok(())
    }

    fn schedule_reconnect(&self) {
        if self.reconnecting.swap(true, Ordering::SeqCst) {
            return;
        }
        let client = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if client.is_connected() {
                    break;
                }
                if client.ensure_connected().await.is_ok() {
                    if let Ok(list) = client.list().await {
                        let _ = client.app.emit("daemon:state", &list);
                    }
                    break;
                }
            }
            client.reconnecting.store(false, Ordering::SeqCst);
        });
    }

    async fn rpc(&self, op: DaemonOp) -> Result<serde_json::Value, String> {
        self.ensure_connected().await?;
        let (writer, pending) = {
            let guard = self.conn.lock().unwrap();
            let Some(c) = guard.as_ref() else {
                return Err("Terminal service is disconnected.".into());
            };
            (c.writer.clone(), Arc::clone(&c.pending))
        };

        let rid = self.counter.fetch_add(1, Ordering::Relaxed);
        let (resp_tx, resp_rx) = oneshot::channel();
        pending.lock().unwrap().insert(rid, resp_tx);

        let req = DaemonRequest { rid, op };
        let mut encoded =
            serde_json::to_string(&req).map_err(|e| format!("RPC encode failed: {e}"))?;
        encoded.push('\n');

        if writer.send(encoded).await.is_err() {
            pending.lock().unwrap().remove(&rid);
            return Err("Terminal service disconnected.".into());
        }

        match tokio::time::timeout(Duration::from_secs(10), resp_rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Terminal service connection closed.".into()),
            Err(_) => {
                pending.lock().unwrap().remove(&rid);
                Err("Terminal service request timed out. Input was not retried.".into())
            }
        }
    }

    pub async fn list(&self) -> Result<Vec<RemoteTerminal>, String> {
        let val = self.rpc(DaemonOp::List).await?;
        let list: Vec<RemoteTerminal> =
            serde_json::from_value(val).map_err(|e| format!("Invalid list response: {e}"))?;
        {
            let mut map = self.known_terminals.lock().unwrap();
            map.clear();
            for t in &list {
                map.insert(t.id, t.clone());
            }
        }
        Ok(list)
    }

    pub async fn start(&self, value: StartTerminal) -> Result<RemoteTerminal, String> {
        let val = self.rpc(DaemonOp::Start { value }).await?;
        serde_json::from_value(val).map_err(|e| format!("Invalid start response: {e}"))
    }

    pub async fn attach(&self, id: u32) -> Result<TerminalSnapshot, String> {
        let val = self.rpc(DaemonOp::Attach { id }).await?;
        serde_json::from_value(val).map_err(|e| format!("Invalid attach response: {e}"))
    }

    pub async fn detach(&self, id: u32) -> Result<(), String> {
        if !self.is_connected() {
            return Ok(());
        }
        let _ = self.rpc(DaemonOp::Detach { id }).await?;
        Ok(())
    }

    pub async fn write(&self, id: u32, data: String) -> Result<(), String> {
        let _ = self.rpc(DaemonOp::Write { id, data }).await?;
        Ok(())
    }

    pub async fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let _ = self.rpc(DaemonOp::Resize { id, cols, rows }).await?;
        Ok(())
    }

    pub async fn kill(&self, id: u32) -> Result<(), String> {
        let _ = self.rpc(DaemonOp::Kill { id }).await?;
        Ok(())
    }

    pub async fn stop_all(&self) -> Result<(), String> {
        let list = self.list().await?;
        for t in list {
            if t.running {
                let _ = self.kill(t.id).await;
            }
        }
        Ok(())
    }

    pub async fn restart(&self) -> Result<(), String> {
        if self.is_connected() {
            let _ = self.rpc(DaemonOp::Shutdown).await;
        }
        *self.conn.lock().unwrap() = None;
        tokio::time::sleep(Duration::from_millis(250)).await;
        self.ensure_connected().await?;
        let list = self.list().await?;
        let _ = self.app.emit("daemon:state", &list);
        Ok(())
    }
}
