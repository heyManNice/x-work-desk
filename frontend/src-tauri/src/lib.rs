use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;

const CHUNK: usize = 1024 * 1024; /* 与浏览器分片一致：1MB/片 */

#[derive(Clone, Serialize)]
struct Prog {
    done: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct ProgRes {
    ok: bool,
    msg: String,
}

/* 剪贴板轮询结果：文本（客户端每次比对去重）+ 本地复制的文件路径 */
#[derive(Clone, Serialize, Default)]
struct ClipPoll {
    text: Option<String>,
    files: Vec<String>,
}

/* ---------------- HTTP 小工具（纯 std，不引外部 http 依赖） ---------------- */

fn split_api(api: &str) -> Result<(String, u16), String> {
    let s = api
        .strip_prefix("http://")
        .or_else(|| api.strip_prefix("https://"))
        .unwrap_or(api);
    let hostport = s.split('/').next().unwrap_or(s);
    if let Some((h, p)) = hostport.rsplit_once(':') {
        let port: u16 = p.parse().map_err(|_| "端口无效".to_string())?;
        Ok((h.to_string(), port))
    } else {
        Ok((hostport.to_string(), 80))
    }
}

fn enc(s: &str) -> String {
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut out = String::new();
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
    }
    out
}

fn basename(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or("file")
}

/* 本地系统“下载”目录（下载远程文件自动保存位置，无需弹窗选择） */
fn downloads_dir() -> PathBuf {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_default()
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    let d = if home.is_empty() {
        PathBuf::from(".")
    } else {
        PathBuf::from(home)
    }
    .join("Downloads");
    let _ = std::fs::create_dir_all(&d);
    d
}

/* 建立连接并发送一个请求，读取响应头返回状态码 + 剩余未读字节 + Content-Length */
fn request(host: &str, port: u16, raw: &str) -> Result<(u16, u64, Vec<u8>, TcpStream), String> {
    let mut st = TcpStream::connect((host, port)).map_err(|e| format!("连接服务器失败：{e}"))?;
    st.write_all(raw.as_bytes()).map_err(|e| format!("发送请求失败：{e}"))?;
    let mut hdr = Vec::new();
    let mut buf = [0u8; 1];
    loop {
        let n = st.read(&mut buf).map_err(|e| format!("读取响应失败：{e}"))?;
        if n == 0 {
            return Err("服务器无响应".to_string());
        }
        hdr.push(buf[0]);
        if hdr.ends_with(b"\r\n\r\n") {
            break;
        }
        if hdr.len() > 32768 {
            return Err("响应头过大".to_string());
        }
    }
    let text = String::from_utf8_lossy(&hdr).into_owned();
    let code: u16 = text
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let mut cl: u64 = 0;
    for line in text.lines() {
        let l = line.to_ascii_lowercase();
        if let Some(v) = l.strip_prefix("content-length:") {
            cl = v.trim().parse().unwrap_or(0);
        }
    }
    let mut rest = Vec::new();
    st.read_to_end(&mut rest).map_err(|e| format!("读取响应失败：{e}"))?;
    Ok((code, cl, rest, st))
}

/* 简易 POST（上传分片），body 为字节；等待 200 */
fn post_chunk(
    host: &str,
    port: u16,
    url_path: &str,
    body: &[u8],
) -> Result<(), String> {
    let req = format!(
        "POST {url_path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let (code, _, _, _) = request(host, port, &req)?;
    if code != 200 {
        return Err(format!("服务器返回 HTTP {code}"));
    }
    // request() 已把 body read_to_end 完（Connection close），无需再读
    Ok(())
}

/* ---------------- Tauri 命令 ---------------- */

/* 下载远程文件到本地“下载”目录（paths 为服务端 realpath 列表）
 * 全自动：不弹任何目录选择框 */
#[tauri::command]
async fn download_remote_files(
    app: AppHandle,
    api: String,
    token: String,
    paths: Vec<String>,
) -> Result<ProgRes, String> {
    let (host, port) = split_api(&api)?;
    let dir = downloads_dir();
    let dirs = dir.to_string_lossy().into_owned();
    let mut done_all: u64 = 0;
    let mut total_all: u64 = 0;
    let mut n = 0usize;
    for p in &paths {
        let name = basename(p).to_string();
        let url_path = format!(
            "/api/transfer/download?token={}&path={}",
            enc(&token),
            enc(p)
        );
        let req = format!(
            "GET {url_path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        );
        let (code, cl, rest, mut st) = request(&host, port, &req)?;
        if code != 200 {
            return Err(format!("{name} 下载失败：HTTP {code}"));
        }
        let target = dir.join(&name);
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("写入 {name} 失败：{e}"))?;
        out.write_all(&rest)
            .map_err(|e| format!("写入 {name} 失败：{e}"))?;
        let mut have = rest.len() as u64;
        done_all += have;
        total_all += cl;
        let _ = app.emit("xwd-transfer-progress", Prog { done: done_all, total: total_all });
        let mut sink = Vec::new();
        st.read_to_end(&mut sink).map_err(|e| format!("读取失败：{e}"))?;
        out.write_all(&sink).map_err(|e| format!("写入失败：{e}"))?;
        done_all += sink.len() as u64;
        have += sink.len() as u64;
        let _ = app.emit("xwd-transfer-progress", Prog { done: done_all, total: total_all });
        if have != cl {
            return Err(format!("{name} 下载不完整 {have}/{cl}"));
        }
        n += 1;
    }
    Ok(ProgRes {
        ok: true,
        msg: format!("已保存 {} 个文件到本地下载目录\n{dirs}", n),
    })
}

/* 上传本地文件到远程（dir 为空则服务端默认落到会话用户桌面） */
#[tauri::command]
async fn upload_local_files(
    app: AppHandle,
    api: String,
    token: String,
    dir: String,
    files: Vec<String>,
) -> Result<ProgRes, String> {
    let (host, port) = split_api(&api)?;
    let mut total_all: u64 = 0;
    for f in &files {
        if let Ok(md) = std::fs::metadata(f) {
            total_all += md.len();
        }
    }
    let mut done_all: u64 = 0;
    let mut n = 0usize;
    for f in files {
        let name = basename(&f).to_string();
        let mut file = std::fs::File::open(&f).map_err(|e| format!("打开 {name} 失败：{e}"))?;
        let mut off: u64 = 0;
        loop {
            let mut buf = vec![0u8; CHUNK];
            let rd = file
                .read(&mut buf)
                .map_err(|e| format!("读取 {name} 失败：{e}"))?;
            if rd == 0 {
                break;
            }
            let url_path = format!(
                "/api/transfer/upload?token={}&dir={}&name={}&offset={}",
                enc(&token),
                enc(&dir),
                enc(&name),
                off
            );
            post_chunk(&host, port, &url_path, &buf[..rd])?;
            done_all += rd as u64;
            off += rd as u64;
            let _ = app.emit("xwd-transfer-progress", Prog { done: done_all, total: total_all });
        }
        n += 1;
    }
    Ok(ProgRes {
        ok: true,
        msg: format!(
            "远程桌面{}（{} 个文件）",
            if dir.is_empty() { "" } else { &dir },
            n
        ),
    })
}

/* ---------------- 系统剪贴板（自动、无弹窗） ---------------- */

/* 写文本到本地系统剪贴板（供远程剪贴板文本同步到本地，无 WebView 权限弹窗） */
#[tauri::command]
fn clip_write_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())
}

/* 本地透明 TCP 转发：监听 127.0.0.1 随机端口，把连接原样转发到目标服务器。
 *
 * 背景：Tauri/WebKitGTK 页面是安全上下文，明文 ws:// 到非 localhost 会被
 * 混合内容规则拦下（无法关闭）。通过把 WebSocket 改连 ws://127.0.0.1:<本端口>
 * （localhost 豁免放行），由本隧道在 Rust 侧无限制地直连远端明文 TCP，
 * 从而实现“远程 IP 也能连”而无需任何证书/CA。
 *
 * 返回本地监听端口；每个接受连接起独立线程双向 copy。监听线程常驻。 */
#[tauri::command]
fn start_tunnel(target_host: String, target_port: u16) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("绑定本地端口失败：{e}"))?;
    let lp = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut local) = conn else { continue };
            let th = target_host.clone();
            std::thread::spawn(move || {
                if let Ok(mut remote) = TcpStream::connect((th.as_str(), target_port)) {
                    let _ = local.set_nodelay(true);
                    let _ = remote.set_nodelay(true);
                    let mut l2 = local.try_clone().ok();
                    let mut r2 = remote.try_clone().ok();
                    let a = std::thread::spawn(move || {
                        if let (Some(mut l), Some(mut r)) = (l2.take(), r2.take()) {
                            let _ = std::io::copy(&mut l, &mut r);
                        }
                    });
                    let _ = std::io::copy(&mut remote, &mut local);
                    let _ = a.join();
                }
            });
        }
    });
    Ok(lp)
}

/* 轮询本地系统剪贴板：当前文本 + 本地复制文件的路径列表。
 * 前端在窗口聚焦/可见时调用，文本比对去重后同步远程；文件自动上传远程桌面 */
#[tauri::command]
fn clip_poll(app: AppHandle) -> Result<ClipPoll, String> {
    let mut poll = ClipPoll::default();
    poll.text = app.clipboard().read_text().ok();
    #[cfg(target_os = "linux")]
    {
        poll.files = clip_local_files_linux();
    }
    Ok(poll)
}

/* Linux：读本机 X11 剪贴板 text/uri-list（文件管理器复制文件）。
 * 客户端运行在桌面会话内（DISPLAY/XAUTHORITY 已带），直接调 xclip */
#[cfg(target_os = "linux")]
fn clip_local_files_linux() -> Vec<String> {
    use std::process::Command;
    let out = Command::new("xclip")
        .args(["-selection", "clipboard", "-t", "text/uri-list", "-o"])
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    let s = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut v = Vec::new();
    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with("file://") {
            continue;
        }
        if let Some(p) = fileuri_to_local(&line[7..]) {
            v.push(p);
        }
    }
    v
}

#[cfg(target_os = "linux")]
fn fileuri_to_local(s: &str) -> Option<String> {
    let mut p = s;
    if let Some(rest) = p.strip_prefix("//") {
        p = rest;
    }
    if !p.starts_with('/') {
        p = p.split_once('/').map(|(_, tail)| tail)?;
    }
    let bytes = p.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let hexv = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(a), Some(b)) = (hexv(bytes[i + 1]), hexv(bytes[i + 2])) {
                out.push((a << 4) | b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/* ---------------- 入口 ---------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            clip_write_text,
            clip_poll,
            download_remote_files,
            upload_local_files,
            start_tunnel
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            /* 拖放无需手工处理：Tauri 会把系统文件拖放作为 tauri://drag-enter/
             * drag-over/drag-drop/drag-leave 事件发到前端，前端监听 onDragDropEvent */
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
