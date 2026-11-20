// SPDX-License-Identifier: GPL-3.0-only
//! OpenRouter client: streaming chat completions, model list, key check.
//! Everything here is plain functions over a base URL so tests can point it at a mock server.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const BASE_URL: &str = "https://openrouter.ai/api/v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// "low" | "medium" | "high", only sent when set.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AiEvent {
    Delta { text: String },
    Usage { prompt_tokens: u64, completion_tokens: u64, cost: Option<f64> },
    /// The model stopped because it reached the output limit, so its reply is cut off.
    Truncated,
    Done,
    Error { kind: String, message: String },
}

/// Error with a stable `kind` the UI turns into a plain message:
/// auth, credit, rate_limit, model, bad_request, provider, network, no_key, other.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AiError {
    pub kind: String,
    pub message: String,
}

impl AiError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: message.into() }
    }
}

pub fn classify_status(status: u16) -> &'static str {
    match status {
        401 | 403 => "auth",
        402 => "credit",
        429 => "rate_limit",
        404 => "model",
        400 | 422 => "bad_request",
        408 | 500..=599 => "provider",
        _ => "other",
    }
}

fn error_message(body: &str, status: u16) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| format!("HTTP {status}"))
}

fn net_error(e: &reqwest::Error) -> AiError {
    if e.is_connect() || e.is_timeout() || e.is_request() {
        AiError::new("network", "Could not reach OpenRouter. Check your internet connection.")
    } else {
        AiError::new("network", format!("Connection problem: {e}"))
    }
}

pub fn build_body(req: &ChatRequest) -> Value {
    let mut b = json!({
        "model": req.model,
        "messages": req.messages,
        "stream": true,
        "usage": { "include": true },
    });
    if let Some(t) = req.temperature {
        b["temperature"] = json!(t);
    }
    if let Some(m) = req.max_tokens {
        b["max_tokens"] = json!(m);
    }
    if let Some(r) = &req.reasoning_effort {
        b["reasoning"] = json!({ "effort": r });
    }
    b
}

/// Turn one SSE `data:` payload into events. Tolerant: unknown shapes yield nothing.
pub fn parse_data(data: &str) -> Vec<AiEvent> {
    let Ok(v) = serde_json::from_str::<Value>(data) else { return vec![] };
    let mut out = vec![];
    if let Some(err) = v.get("error") {
        let msg = err["message"].as_str().unwrap_or("The provider reported an error.").to_string();
        let kind = err["code"].as_u64().map(|c| classify_status(c as u16)).unwrap_or("provider");
        out.push(AiEvent::Error { kind: kind.into(), message: msg });
        return out;
    }
    if let Some(text) = v["choices"][0]["delta"]["content"].as_str() {
        if !text.is_empty() {
            out.push(AiEvent::Delta { text: text.into() });
        }
    }
    if v["choices"][0]["finish_reason"].as_str() == Some("length") {
        out.push(AiEvent::Truncated);
    }
    if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
        out.push(AiEvent::Usage {
            prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
            completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0),
            cost: u["cost"].as_f64(),
        });
    }
    out
}

/// Incremental SSE reader: feed raw bytes, get complete `data:` payloads back.
#[derive(Default)]
pub struct SseBuffer {
    buf: Vec<u8>,
}

impl SseBuffer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = vec![];
        while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            // Lines starting with ':' are comments (OpenRouter sends keep-alive pings).
            if let Some(d) = line.strip_prefix("data:") {
                out.push(d.trim_start().to_string());
            }
        }
        out
    }
}

/// Stream a chat completion, calling `emit` for each event. Always ends with either
/// `Done` or `Error`.
pub async fn stream_chat(client: &reqwest::Client, base: &str, key: &str, req: &ChatRequest, mut emit: impl FnMut(AiEvent)) {
    let resp = match client.post(format!("{base}/chat/completions")).bearer_auth(key).json(&build_body(req)).send().await {
        Ok(r) => r,
        Err(e) => {
            let err = net_error(&e);
            return emit(AiEvent::Error { kind: err.kind, message: err.message });
        }
    };
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let body = resp.text().await.unwrap_or_default();
        return emit(AiEvent::Error { kind: classify_status(status).into(), message: error_message(&body, status) });
    }
    let mut sse = SseBuffer::default();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let err = net_error(&e);
                return emit(AiEvent::Error { kind: err.kind, message: err.message });
            }
        };
        for data in sse.push(&chunk) {
            if data == "[DONE]" {
                return emit(AiEvent::Done);
            }
            for ev in parse_data(&data) {
                let failed = matches!(ev, AiEvent::Error { .. });
                emit(ev);
                if failed {
                    return;
                }
            }
        }
    }
    emit(AiEvent::Done);
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context_length: u64,
    /// USD per million tokens, when the provider lists a price.
    pub prompt_price: Option<f64>,
    pub completion_price: Option<f64>,
}

pub fn parse_models(v: &Value) -> Vec<ModelInfo> {
    let per_million = |p: &Value| p.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| p.as_f64()).map(|x| x * 1_000_000.0);
    let mut out: Vec<ModelInfo> = v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    let id = m["id"].as_str()?.to_string();
                    Some(ModelInfo {
                        name: m["name"].as_str().unwrap_or(&id).to_string(),
                        context_length: m["context_length"].as_u64().unwrap_or(0),
                        prompt_price: per_million(&m["pricing"]["prompt"]),
                        completion_price: per_million(&m["pricing"]["completion"]),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

async fn get_json(client: &reqwest::Client, url: String, key: &str) -> Result<Value, AiError> {
    let resp = client.get(url).bearer_auth(key).send().await.map_err(|e| net_error(&e))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| net_error(&e))?;
    if !(200..300).contains(&status) {
        return Err(AiError::new(classify_status(status), error_message(&body, status)));
    }
    serde_json::from_str(&body).map_err(|e| AiError::new("other", format!("Unexpected response from OpenRouter: {e}")))
}

pub async fn list_models(client: &reqwest::Client, base: &str, key: &str) -> Result<Vec<ModelInfo>, AiError> {
    Ok(parse_models(&get_json(client, format!("{base}/models"), key).await?))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub label: String,
    /// USD spent so far.
    pub usage: Option<f64>,
    /// USD credit limit, if the key has one.
    pub limit: Option<f64>,
    pub limit_remaining: Option<f64>,
}

pub async fn key_info(client: &reqwest::Client, base: &str, key: &str) -> Result<KeyInfo, AiError> {
    let v = get_json(client, format!("{base}/auth/key"), key).await?;
    let d = &v["data"];
    Ok(KeyInfo {
        label: d["label"].as_str().unwrap_or("").to_string(),
        usage: d["usage"].as_f64(),
        limit: d["limit"].as_f64(),
        limit_remaining: d["limit_remaining"].as_f64(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A mock provider: answers one request with `status` and `body`, optionally stalling
    /// after the first `split` bytes of the body (to test cancellation). Returns the base URL
    /// and a record of the request it received.
    async fn mock(status: &str, content_type: &str, body: String, stall_after: Option<usize>) -> (String, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(String::new()));
        let seen2 = seen.clone();
        let head = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n");
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut tmp = [0u8; 4096];
            loop {
                let n = sock.read(&mut tmp).await.unwrap();
                req.extend_from_slice(&tmp[..n]);
                let text = String::from_utf8_lossy(&req).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let len = text[..h].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if req.len() >= h + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            *seen2.lock().unwrap() = String::from_utf8_lossy(&req).to_string();
            sock.write_all(head.as_bytes()).await.unwrap();
            match stall_after {
                Some(k) => {
                    sock.write_all(&body.as_bytes()[..k]).await.unwrap();
                    sock.flush().await.unwrap();
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                None => {
                    sock.write_all(body.as_bytes()).await.unwrap();
                }
            }
        });
        (base, seen)
    }

    fn req() -> ChatRequest {
        ChatRequest {
            model: "test/model".into(),
            messages: vec![Message { role: "user".into(), content: "hi".into() }],
            temperature: Some(0.7),
            max_tokens: Some(100),
            reasoning_effort: None,
        }
    }

    async fn collect(base: &str, key: &str) -> Vec<AiEvent> {
        let client = reqwest::Client::new();
        let mut events = vec![];
        stream_chat(&client, base, key, &req(), |e| events.push(e)).await;
        events
    }

    const SSE: &str = ": OPENROUTER PROCESSING\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\ndata: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":2,\"cost\":0.0004}}\n\ndata: [DONE]\n\n";

    #[test]
    fn a_reply_that_hit_the_output_limit_is_flagged() {
        let ev = parse_data(r#"{"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}"#);
        assert_eq!(ev, vec![AiEvent::Delta { text: "cut".into() }, AiEvent::Truncated]);
        assert!(parse_data(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#).is_empty());
    }

    #[tokio::test]
    async fn streams_deltas_usage_and_done() {
        let (base, seen) = mock("200 OK", "text/event-stream", SSE.into(), None).await;
        let events = collect(&base, "sk-test-key").await;
        assert_eq!(
            events,
            vec![
                AiEvent::Delta { text: "Hel".into() },
                AiEvent::Delta { text: "lo".into() },
                AiEvent::Usage { prompt_tokens: 12, completion_tokens: 2, cost: Some(0.0004) },
                AiEvent::Done,
            ]
        );
        let sent = seen.lock().unwrap().clone();
        assert!(sent.starts_with("POST /chat/completions"));
        assert!(sent.to_lowercase().contains("authorization: bearer sk-test-key"));
        assert!(sent.contains("\"stream\":true") && sent.contains("\"model\":\"test/model\""));
    }

    #[tokio::test]
    async fn maps_http_errors_to_plain_kinds() {
        for (status, kind) in [("401 Unauthorized", "auth"), ("402 Payment Required", "credit"), ("429 Too Many Requests", "rate_limit"), ("404 Not Found", "model"), ("503 Service Unavailable", "provider")] {
            let (base, _) = mock(status, "application/json", r#"{"error":{"message":"nope"}}"#.into(), None).await;
            let events = collect(&base, "k").await;
            assert_eq!(events, vec![AiEvent::Error { kind: kind.into(), message: "nope".into() }], "{status}");
        }
    }

    #[tokio::test]
    async fn reports_mid_stream_errors_and_stops() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\ndata: {\"error\":{\"code\":429,\"message\":\"slow down\"}}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"never\"}}]}\n\n";
        let (base, _) = mock("200 OK", "text/event-stream", body.into(), None).await;
        let events = collect(&base, "k").await;
        assert_eq!(events, vec![AiEvent::Delta { text: "a".into() }, AiEvent::Error { kind: "rate_limit".into(), message: "slow down".into() }]);
    }

    #[tokio::test]
    async fn network_failure_is_reported() {
        // Nothing is listening on this port.
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        drop(l);
        let events = collect(&base, "k").await;
        assert!(matches!(&events[..], [AiEvent::Error { kind, .. }] if kind == "network"));
    }

    #[tokio::test]
    async fn aborting_the_task_cancels_a_stalled_stream() {
        let first = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
        let (base, _) = mock("200 OK", "text/event-stream", format!("{first}data: more\n\n"), Some(first.len())).await;
        let got = Arc::new(Mutex::new(vec![]));
        let got2 = got.clone();
        let handle = tokio::spawn(async move {
            let client = reqwest::Client::new();
            stream_chat(&client, &base, "k", &req(), |e| got2.lock().unwrap().push(e)).await;
        });
        // Wait for the first delta, then cancel.
        for _ in 0..100 {
            if !got.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(got.lock().unwrap().first(), Some(&AiEvent::Delta { text: "partial".into() }));
        handle.abort();
        assert!(handle.await.unwrap_err().is_cancelled());
        assert!(!got.lock().unwrap().contains(&AiEvent::Done));
    }

    #[test]
    fn sse_buffer_handles_split_chunks_and_comments() {
        let mut b = SseBuffer::default();
        assert!(b.push(b": ping\n\ndata: {\"a\"").is_empty());
        assert_eq!(b.push(b":1}\r\n\r\ndata: [DONE]\n"), vec!["{\"a\":1}".to_string(), "[DONE]".to_string()]);
        // Multi-byte characters split across chunks survive.
        let mut b = SseBuffer::default();
        let s = "data: é\n".as_bytes();
        assert!(b.push(&s[..7]).is_empty());
        assert_eq!(b.push(&s[7..]), vec!["é".to_string()]);
    }

    #[test]
    fn parses_models_with_prices_per_million() {
        let v: Value = serde_json::from_str(r#"{"data":[{"id":"b/m2","name":"Zed","context_length":8000,"pricing":{"prompt":"0.000003","completion":"0.000015"}},{"id":"a/m1","context_length":1000,"pricing":{}}]}"#).unwrap();
        let m = parse_models(&v);
        assert_eq!(m[0].id, "a/m1");
        assert_eq!(m[0].name, "a/m1");
        assert_eq!(m[0].prompt_price, None);
        assert!((m[1].prompt_price.unwrap() - 3.0).abs() < 1e-9);
        assert!((m[1].completion_price.unwrap() - 15.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn key_and_model_endpoints() {
        let (base, seen) = mock("200 OK", "application/json", r#"{"data":{"label":"my key","usage":1.5,"limit":10.0,"limit_remaining":8.5}}"#.into(), None).await;
        let info = key_info(&reqwest::Client::new(), &base, "k").await.unwrap();
        assert_eq!(info, KeyInfo { label: "my key".into(), usage: Some(1.5), limit: Some(10.0), limit_remaining: Some(8.5) });
        assert!(seen.lock().unwrap().starts_with("GET /auth/key"));
        let (base, _) = mock("401 Unauthorized", "application/json", r#"{"error":{"message":"No auth"}}"#.into(), None).await;
        let err = key_info(&reqwest::Client::new(), &base, "bad").await.unwrap_err();
        assert_eq!(err, AiError::new("auth", "No auth"));
    }

    #[test]
    fn optional_request_fields_are_only_sent_when_set() {
        let mut r = req();
        r.reasoning_effort = Some("high".into());
        let b = build_body(&r);
        assert_eq!(b["reasoning"]["effort"], "high");
        r.temperature = None;
        r.max_tokens = None;
        r.reasoning_effort = None;
        let b = build_body(&r);
        assert!(b.get("temperature").is_none() && b.get("max_tokens").is_none() && b.get("reasoning").is_none());
    }
}
