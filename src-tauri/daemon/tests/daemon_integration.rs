use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(windows)]
use std::net::TcpStream;

fn send_rpc<R: Read, W: Write>(
    reader: &mut BufReader<R>,
    writer: &mut W,
    rid: u64,
    payload: Value,
) -> Value {
    let mut obj = payload.as_object().unwrap().clone();
    obj.insert("rid".into(), json!(rid));
    let mut line = serde_json::to_string(&Value::Object(obj)).unwrap();
    line.push('\n');
    writer.write_all(line.as_bytes()).unwrap();
    writer.flush().unwrap();

    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        assert!(Instant::now() < deadline, "Timed out waiting for RPC rid={rid}");
        let mut buf = String::new();
        let n = reader.read_line(&mut buf).unwrap();
        assert!(n > 0, "Daemon closed connection while awaiting rid={rid}");
        let msg: Value = serde_json::from_str(buf.trim()).unwrap();
        if msg.get("rid").and_then(|v| v.as_u64()) == Some(rid) {
            return msg;
        }
    }
}

#[cfg(unix)]
fn connect_daemon(runtime_dir: &Path) -> Option<(BufReader<UnixStream>, UnixStream)> {
    let stream = UnixStream::connect(runtime_dir.join("service.sock")).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(8))).ok()?;
    let writer = stream.try_clone().ok()?;
    Some((BufReader::new(stream), writer))
}

#[cfg(windows)]
fn connect_daemon(runtime_dir: &Path) -> Option<(BufReader<TcpStream>, TcpStream)> {
    let port_text = fs::read_to_string(runtime_dir.join("port")).ok()?;
    let port: u16 = port_text.trim().parse().ok()?;
    let stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(8))).ok()?;
    let writer = stream.try_clone().ok()?;
    Some((BufReader::new(stream), writer))
}

#[test]
fn daemon_persists_pty_and_replays_scrollback_across_reconnect() {
    let bin = env!("CARGO_BIN_EXE_ronin-daemon");
    let runtime_dir = std::env::temp_dir().join(format!(
        "ronin-daemon-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&runtime_dir).unwrap();
    #[cfg(unix)]
    fs::set_permissions(&runtime_dir, fs::Permissions::from_mode(0o700)).unwrap();

    let token = "a".repeat(64);
    let token_path = runtime_dir.join("token");
    #[cfg(unix)]
    {
        let mut tf = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&token_path)
            .unwrap();
        tf.write_all(token.as_bytes()).unwrap();
    }
    #[cfg(windows)]
    {
        let mut tf = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&token_path)
            .unwrap();
        tf.write_all(token.as_bytes()).unwrap();
    }

    let mut child = Command::new(bin)
        .arg("--daemon")
        .arg(&runtime_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn ronin-daemon");

    let mut conn = None;
    for _ in 0..80 {
        if let Some(c) = connect_daemon(&runtime_dir) {
            conn = Some(c);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let (mut reader, mut writer) = conn.expect("connect to daemon");

    // 1. Authenticate
    let hello = send_rpc(
        &mut reader,
        &mut writer,
        1,
        json!({ "op": "hello", "version": 1, "token": token }),
    );
    assert!(hello.get("error").is_none(), "hello failed: {hello}");

    // 2. Start PTY running platform shell
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let mut env_map: HashMap<String, String> = std::env::vars().collect();
    #[cfg(unix)]
    let (shell, write_cmd) = (
        "/bin/sh",
        "printf '\\033[?1006hRONIN_PERSIST_MARKER_42\\n'\r",
    );
    #[cfg(windows)]
    let (shell, write_cmd) = ("cmd.exe", "echo RONIN_PERSIST_MARKER_42\r\n");

    env_map.entry("TERM".into()).or_insert_with(|| "xterm-256color".into());

    let started = send_rpc(
        &mut reader,
        &mut writer,
        2,
        json!({
            "op": "start",
            "value": {
                "id": 1,
                "cwd": cwd,
                "shell": shell,
                "env": env_map,
                "cols": 80,
                "rows": 24
            }
        }),
    );
    assert!(started.get("error").is_none(), "start failed: {started}");
    assert_eq!(started["value"]["running"], json!(true));

    // 3. Write unique marker
    let write_res = send_rpc(
        &mut reader,
        &mut writer,
        3,
        json!({
            "op": "write",
            "id": 1,
            "data": write_cmd
        }),
    );
    assert!(write_res.get("error").is_none());
    std::thread::sleep(Duration::from_millis(500));

    // 4. Disconnect first client completely!
    drop(reader);
    drop(writer);
    std::thread::sleep(Duration::from_millis(150));

    // 5. Reconnect fresh client and verify session survived + snapshot contains marker
    let (mut reader2, mut writer2) = connect_daemon(&runtime_dir).expect("reconnect to daemon");

    let hello2 = send_rpc(
        &mut reader2,
        &mut writer2,
        10,
        json!({ "op": "hello", "version": 1, "token": token }),
    );
    assert!(hello2.get("error").is_none());

    let attach = send_rpc(&mut reader2, &mut writer2, 11, json!({ "op": "attach", "id": 1 }));
    assert!(attach.get("error").is_none(), "attach failed: {attach}");
    let replay = attach["value"]["data"].as_str().unwrap_or("");
    assert!(
        replay.contains("RONIN_PERSIST_MARKER_42"),
        "expected marker in replay, got: {replay:?}"
    );
    #[cfg(unix)]
    assert!(
        replay.contains("\x1b[?1006h"),
        "expected SGR mouse encoding ?1006h in replay"
    );

    // 6. Clean shutdown
    let shut = send_rpc(&mut reader2, &mut writer2, 12, json!({ "op": "shutdown" }));
    assert!(shut.get("error").is_none());
    let _ = child.wait();
    let _ = fs::remove_dir_all(&runtime_dir);
}
