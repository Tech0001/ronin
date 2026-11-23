// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer triggers GDK Wayland Error 71 (Protocol error)
    // on NVIDIA + Wayland compositors (e.g. Hyprland). Disable DMA-BUF when
    // running on Wayland + NVIDIA unless the user explicitly overrides it.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && (std::path::Path::new("/dev/nvidia0").exists()
            || std::path::Path::new("/proc/driver/nvidia/version").exists())
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    ronin_lib::run();
}
