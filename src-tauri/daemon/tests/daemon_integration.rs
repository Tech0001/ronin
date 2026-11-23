use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn send_rpc(
    reader: &mut BufReader<UnixStream>,
    writer: &mut UnixStream,
    rid: u64,
    payload: Value,
) -> Value {
    let mut obj = payload.as_object().unwrap().clone();
    obj.insert("rid".into(), json!(rid));
    let mut line = serde_json::to_string(&Value::Object(obj)).unwrap();
    line.push('\n');
    writer.write_all(line.as_bytes()).unwrap();
    writer.flush().unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
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

#[test]
fn daemon_persists_pty_and_replays_scrollback_across_reconnect() {
    let bin = env!("CARGO_BIN_EXE_ronin-daemon");
    let runtime_dir = std::env::temp_dir().join(format!(
        "ronin-daemon-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&runtime_dir).unwrap();
    fs::set_permissions(&runtime_dir, fs::Permissions::from_mode(0o700)).unwrap();

    let token = "a".repeat(64);
    let token_path = runtime_dir.join("token");
    let mut tf = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&token_path)
        .unwrap();
    tf.write_all(token.as_bytes()).unwrap();
    drop(tf);

    let mut child = Command::new(bin)
        .arg("--daemon")
        .arg(&runtime_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn ronin --daemon");

    let sock_path = runtime_dir.join("service.sock");
    let mut stream = None;
    for _ in 0..50 {
        if let Ok(s) = UnixStream::connect(&sock_path) {
            stream = Some(s);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let stream = stream.expect("connect to daemon socket");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);

    // 1. Authenticate
    let hello = send_rpc(
        &mut reader,
        &mut writer,
        1,
        json!({ "op": "hello", "version": 1, "token": token }),
    );
    assert!(hello.get("error").is_none(), "hello failed: {hello}");

    // 2. Start PTY running /bin/sh (or /bin/bash)
    let mut env_map = HashMap::new();
    env_map.insert("PATH".to_string(), "/usr/local/bin:/usr/bin:/bin".to_string());
    env_map.insert("HOME".to_string(), "/tmp".to_string());
    let started = send_rpc(
        &mut reader,
        &mut writer,
        2,
        json!({
            "op": "start",
            "value": {
                "id": 1,
                "cwd": "/tmp",
                "shell": "/bin/bash",
                "env": env_map,
                "cols": 80,
                "rows": 24
            }
        }),
    );
    assert!(started.get("error").is_none(), "start failed: {started}");
    assert_eq!(started["value"]["running"], json!(true));

    // 3. Write unique marker + enable SGR mouse encoding 1006
    let write_res = send_rpc(
        &mut reader,
        &mut writer,
        3,
        json!({
            "op": "write",
            "id": 1,
            "data": "printf '\\033[?1006hRONIN_PERSIST_MARKER_42\\n'\r"
        }),
    );
    assert!(write_res.get("error").is_none());
    std::thread::sleep(Duration::from_millis(350));

    // 4. Disconnect first client completely!
    drop(reader);
    drop(writer);
    std::thread::sleep(Duration::from_millis(120));

    // 5. Reconnect fresh client and verify session survived + snapshot contains marker & ?1006h
    let stream2 = UnixStream::connect(&sock_path).expect("reconnect to daemon");
    stream2.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut writer2 = stream2.try_clone().unwrap();
    let mut reader2 = BufReader::new(stream2);

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
