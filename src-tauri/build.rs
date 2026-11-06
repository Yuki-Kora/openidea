fn main() {
    let root =
        dunce::canonicalize(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).expect("worktree root");
    println!("cargo:rustc-env=OPENIDEA_WORKTREE_ROOT={}", root.display());
    let profile = root.join(".openidea-dev-identity");
    println!("cargo:rerun-if-changed={}", profile.display());
    if let Ok(value) = std::fs::read_to_string(&profile) {
        let value = value.trim();
        let prefix = "ai.l0ng.openidea.dev.w";
        assert!(value.strip_prefix(prefix).is_some_and(|hash| hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit())), "invalid development identity");
        println!("cargo:rustc-env=OPENIDEA_DEV_IDENTITY={value}");
    }
    // Windows (MSVC): link the Common-Controls v6 manifest into every binary of
    // this package, not only the app's resources, so test executables such as
    // `export_bindings` can load comctl32 and don't exit with
    // STATUS_ENTRYPOINT_NOT_FOUND.
    let mut windows = tauri_build::WindowsAttributes::new();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri build");
}
