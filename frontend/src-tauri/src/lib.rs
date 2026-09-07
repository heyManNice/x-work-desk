use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpStream;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

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

/* 选择保存目录（下载远程文件用） */
#[tauri::command]
async fn pick_save_dir(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .pick_folder(move |p| {
            let _ = tx.send(
                p.and_then(|f| f.into_path().ok())
                    .map(|pb| pb.to_string_lossy().into_owned()),
            );
        });
    Ok(rx.recv_timeout(std::time::Duration::from_secs(600)).unwrap_or(None))
}

/* 选择本地文件（上传到远程） */
#[tauri::command]
async fn pick_upload_files(app: AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("所有文件", &["*"])
        .pick_files(move |files| {
            let v = files
                .map(|fs| {
                    fs.into_iter()
                        .filter_map(|f| f.into_path().ok())
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let _ = tx.send(v);
        });
    Ok(rx.recv_timeout(std::time::Duration::from_secs(600)).unwrap_or_default())
}

/* 下载远程文件到本地目录（paths 为服务端 realpath 列表） */
#[tauri::command]
async fn download_remote_files(
    app: AppHandle,
    api: String,
    token: String,
    paths: Vec<String>,
    dir: String,
) -> Result<ProgRes, String> {
    let (host, port) = split_api(&api)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let mut done_all: u64 = 0;
    let mut total_all: u64 = 0;
    let mut finished: Vec<String> = Vec::new();
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
        let target = std::path::Path::new(&dir).join(&name);
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("写入 {name} 失败：{e}"))?;
        out.write_all(&rest)
            .map_err(|e| format!("写入 {name} 失败：{e}"))?;
        let mut have = rest.len() as u64;
        done_all += have;
        total_all += cl;
        let _ = app.emit("xwd-transfer-progress", Prog { done: done_all, total: total_all });
        // 继续读完剩余（request 已 read_to_end，rest 即全部 body）
        let mut sink = Vec::new();
        st.read_to_end(&mut sink).map_err(|e| format!("读取失败：{e}"))?;
        out.write_all(&sink).map_err(|e| format!("写入失败：{e}"))?;
        done_all += sink.len() as u64;
        have += sink.len() as u64;
        let _ = app.emit("xwd-transfer-progress", Prog { done: done_all, total: total_all });
        if have != cl {
            return Err(format!("{name} 下载不完整 {have}/{cl}"));
        }
        finished.push(name);
    }
    Ok(ProgRes { ok: true, msg: format!("已保存 {} 个文件", finished.len()) })
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

/* ---------------- 入口 ---------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pick_save_dir,
            pick_upload_files,
            download_remote_files,
            upload_local_files
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
