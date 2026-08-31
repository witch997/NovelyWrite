// NovelyWrite Tauri 壳：原生窗口 + sidecar（SEA exe server）
// - 启动：spawn sidecar（NovelyWrite.exe --sidecar）→ 窗口加载 http://127.0.0.1:3081
// - 退出：主窗口关闭 → 杀 sidecar 子进程 → 退出
use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::ShellExt;

struct SidecarChild(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 1. 启动 sidecar（SEA exe，--sidecar 模式：不开浏览器、无心跳、固定 3081）
            //    （tauri-plugin-shell 已内置 CREATE_NO_WINDOW，sidecar 不弹控制台）
            let sidecar = app
                .shell()
                .sidecar("nw-server")?
                .args(["--sidecar"])
                .spawn()
                .map_err(|e| format!("sidecar 启动失败: {e}"))?;
            app.manage(SidecarChild(Mutex::new(Some(sidecar.1))));

            // 2. 创建原生窗口，加载 server 页面（等 1.5s 让 server 就绪）
            std::thread::spawn(|| std::thread::sleep(std::time::Duration::from_millis(1500)));
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External("http://127.0.0.1:3081".parse().unwrap()))
                .title("NovelyWrite")
                .inner_size(1280.0, 960.0)
                .min_inner_size(1200.0, 700.0)
                .maximized(true) // 打开即最大化（填满屏幕，保留任务栏；可点还原）
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用构建失败")
        .run(|app_handle, event| {
            // 主窗口关闭/应用退出 → 杀 sidecar
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<SidecarChild>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
