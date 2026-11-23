use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const PROTOCOL: u32 = 1;
pub const FRAME_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTerminal {
    pub id: u32,
    pub pid: u32,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub generation: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub id: u32,
    pub pid: u32,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub generation: String,
    pub cols: u16,
    pub rows: u16,
    pub seq: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTerminal {
    pub id: u32,
    pub cwd: String,
    pub shell: String,
    pub env: HashMap<String, String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInfo {
    pub version: u32,
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DaemonOp {
    Hello { version: u32, token: String },
    List,
    Start { value: StartTerminal },
    Attach { id: u32 },
    Detach { id: u32 },
    Write { id: u32, data: String },
    Resize { id: u32, cols: u16, rows: u16 },
    Kill { id: u32 },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonRequest {
    pub rid: u64,
    #[serde(flatten)]
    pub op: DaemonOp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DaemonMessage {
    Event(DaemonEvent),
    Response(DaemonResponse),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum DaemonEvent {
    State {
        terminals: Vec<RemoteTerminal>,
    },
    Output {
        id: u32,
        generation: String,
        seq: u64,
        data: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonResponse {
    pub rid: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
