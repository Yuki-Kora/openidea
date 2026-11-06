// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(windows, debug_assertions))]
    if let Some(id) = option_env!("OPENIDEA_DEV_IDENTITY") {
        let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
        // Set before creating any windows so the taskbar groups them with the launcher.
        unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
    }
    // Started by `ssh` / `git` as their askpass program: answer and exit, no UI.
    if let Some(code) = ide_ssh::askpass::run_helper() {
        std::process::exit(code);
    }
    openidea_lib::run()
}
