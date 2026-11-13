//! Perforce commands scoped to the active project and its configured workspace.
use crate::state::AppState;
use ide_core::{IdeError, IdeResult};
use serde::Serialize;
use specta::Type;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{State, Window};

#[derive(Serialize, Type)]
pub struct P4Info {
    client: String,
    user: String,
    root: String,
    server: String,
}

#[derive(Clone, Serialize, Type)]
pub struct P4Opened {
    path: String,
    depot: String,
    action: String,
    change: String,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct P4Annotation {
    change: String,
    user: String,
    time: String,
}

#[derive(Serialize, Type)]
pub struct P4Blame {
    lines: Vec<P4Annotation>,
    hunks: Vec<ide_vcs::LineHunk>,
}

fn run(root: &Path, args: &[&str]) -> IdeResult<String> {
    let output =
        Command::new("p4").arg("-d").arg(root).args(args).stdin(Stdio::null()).output().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { IdeError::missing_tool("p4") } else { e.into() }
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(IdeError::unavailable(format!(
            "Perforce: {}",
            if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }
        )));
    }
    Ok(stdout)
}

fn records(output: &str, first: &str) -> Vec<HashMap<String, String>> {
    let mut result = Vec::new();
    let mut current = HashMap::new();
    for line in output.lines() {
        let Some(line) = line.strip_prefix("... ") else { continue };
        let Some((key, value)) = line.split_once(' ') else { continue };
        if key == first && !current.is_empty() {
            result.push(std::mem::take(&mut current));
        }
        current.insert(key.to_owned(), value.to_owned());
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

fn info(root: &Path) -> IdeResult<P4Info> {
    let output = run(root, &["-ztag", "info"])?;
    let fields = records(&output, "userName").into_iter().next().unwrap_or_default();
    let get = |key: &str| fields.get(key).cloned().unwrap_or_default();
    let info = P4Info {
        client: get("clientName"),
        user: get("userName"),
        root: get("clientRoot"),
        server: get("serverAddress"),
    };
    if info.client.is_empty() || info.root.is_empty() || info.root == "*unknown*" {
        return Err(IdeError::unavailable("Perforce workspace is not configured"));
    }
    Ok(info)
}

fn opened(root: &Path) -> IdeResult<Vec<P4Opened>> {
    let info = info(root)?;
    let root_text = root.to_string_lossy();
    if root_text.contains(['*', '@', '#', '%']) || root_text.contains("...") {
        return Err(IdeError::invalid("Project path contains Perforce filespec characters"));
    }
    let spec = format!("{}/...", root.to_string_lossy().replace('\\', "/").trim_end_matches('/'));
    let output = run(root, &["-ztag", "opened", &spec])?;
    let prefix = format!("//{}/", info.client);
    Ok(records(&output, "depotFile")
        .into_iter()
        .filter_map(|r| {
            let client_file = r.get("clientFile")?;
            let relative = client_file.strip_prefix(&prefix)?;
            let path = Path::new(&info.root).join(relative);
            Some(P4Opened {
                path: path.to_string_lossy().into_owned(),
                depot: r.get("depotFile")?.clone(),
                action: r.get("action")?.clone(),
                change: r.get("change")?.clone(),
            })
        })
        .collect())
}

// Reject filespec syntax instead of allowing one selection to expand into many.
fn exact_file(root: &Path, path: &str) -> IdeResult<String> {
    if path.is_empty() || path.contains(['*', '@', '#', '%']) || path.contains("...") {
        return Err(IdeError::invalid("Invalid Perforce file path"));
    }
    let path = PathBuf::from(path);
    let canonical = dunce::canonicalize(&path).map_err(|_| IdeError::invalid("File must exist in the project"))?;
    let base = dunce::canonicalize(root)?;
    if !canonical.starts_with(&base) || !canonical.is_file() {
        return Err(IdeError::invalid("File is outside the project"));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

async fn scoped<T: Send + 'static>(
    window: Window,
    state: State<'_, AppState>,
    task: impl FnOnce(PathBuf) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    state.host.require_trust(window.label())?;
    let root = state.host.project(window.label())?.root.clone();
    tokio::task::spawn_blocking(move || task(root)).await.map_err(|e| IdeError::internal(e.to_string()))?
}

#[tauri::command]
#[specta::specta]
pub async fn p4_info(window: Window, state: State<'_, AppState>) -> IdeResult<P4Info> {
    scoped(window, state, |root| info(&root)).await
}
#[tauri::command]
#[specta::specta]
pub async fn p4_opened(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<P4Opened>> {
    scoped(window, state, |root| opened(&root)).await
}
#[tauri::command]
#[specta::specta]
pub async fn p4_diff(window: Window, state: State<'_, AppState>, path: String) -> IdeResult<String> {
    scoped(window, state, move |root| {
        let path = exact_file(&root, &path)?;
        run(&root, &["diff", "-du", &path])
    })
    .await
}
/// Compare the exact workspace #have revision with the editor buffer, never disk.
#[tauri::command]
#[specta::specta]
pub async fn p4_line_hunks(
    window: Window,
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> IdeResult<Vec<ide_vcs::LineHunk>> {
    scoped(window, state, move |root| {
        if text.len() > 4 * 1024 * 1024 {
            return Err(IdeError::invalid("File is too large for Perforce line tracking"));
        }
        let path = exact_file(&root, &path)?;
        let spec = format!("{path}#have");
        let output = Command::new("p4")
            .arg("-d")
            .arg(&root)
            .args(["print", "-q", &spec])
            .stdin(Stdio::null())
            .output()
            .map_err(
                |e| if e.kind() == std::io::ErrorKind::NotFound { IdeError::missing_tool("p4") } else { e.into() },
            )?;
        if !output.status.success() {
            return Err(IdeError::unavailable("Perforce #have revision is unavailable"));
        }
        compare_have(&output.stdout, &text)
    })
    .await
}
fn compare_have(base: &[u8], text: &str) -> IdeResult<Vec<ide_vcs::LineHunk>> {
    if base.len() > 4 * 1024 * 1024 || base.contains(&0) {
        return Err(IdeError::invalid("Perforce base is not supported UTF-8 text"));
    }
    let base = std::str::from_utf8(base).map_err(|_| IdeError::invalid("Perforce base is not UTF-8"))?;
    Ok(ide_vcs::diff_hunks(base, text))
}

#[tauri::command]
#[specta::specta]
pub async fn p4_blame(window: Window, state: State<'_, AppState>, path: String, text: String) -> IdeResult<P4Blame> {
    scoped(window, state, move |root| {
        if text.len() > 4 * 1024 * 1024 {
            return Err(IdeError::invalid("File is too large for Perforce annotations"));
        }
        let path = exact_file(&root, &path)?;
        let spec = format!("{path}#have");
        let base = Command::new("p4")
            .arg("-d")
            .arg(&root)
            .args(["print", "-q", &spec])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { IdeError::missing_tool("p4") } else { e.into() }
        })?;
        if !base.status.success() {
            return Err(IdeError::unavailable("Perforce #have revision is unavailable"));
        }
        let hunks = compare_have(&base.stdout, &text)?;
        let output = run(&root, &["-ztag", "annotate", "-c", "-u", &spec])?;
        let lines: Vec<P4Annotation> = records(&output, "upper")
            .into_iter()
            .filter_map(|r| {
                Some(P4Annotation {
                    change: r.get("lower")?.clone(),
                    user: r.get("user")?.clone(),
                    time: r.get("time")?.clone(),
                })
            })
            .collect();
        let base_text =
            std::str::from_utf8(&base.stdout).map_err(|_| IdeError::invalid("Perforce base is not UTF-8"))?;
        let expected = base_text.lines().count();
        if lines.len() != expected {
            return Err(IdeError::unavailable("Perforce annotation line count does not match #have"));
        }
        Ok(P4Blame { lines, hunks })
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn p4_edit(window: Window, state: State<'_, AppState>, path: String) -> IdeResult<()> {
    scoped(window, state, move |root| {
        let path = exact_file(&root, &path)?;
        run(&root, &["edit", &path])?;
        Ok(())
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn p4_submit(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<String>,
    description: String,
) -> IdeResult<String> {
    scoped(window, state, move |root| {
        if paths.is_empty() || paths.len() > 1000 || description.trim().is_empty() {
            return Err(IdeError::invalid("Select files and enter a description"));
        }
        let available = opened(&root)?;
        let mut selected = Vec::new();
        for path in paths {
            let path = exact_file(&root, &path)?;
            let entry = available
                .iter()
                .find(|e| {
                    dunce::canonicalize(&e.path).ok().as_ref() == Some(&PathBuf::from(&path)) && e.change == "default"
                })
                .ok_or_else(|| IdeError::invalid("Only files opened in the default changelist can be submitted"))?;
            if !selected.contains(&entry.depot) {
                selected.push(entry.depot.clone());
            }
        }
        if selected.iter().any(|s| s.contains(['*', '@', '#', '%']) || s.contains("...")) {
            return Err(IdeError::invalid("Unsupported Perforce file name"));
        }
        let mut args = vec!["submit", "-Sx", "-d", description.as_str()];
        args.extend(selected.iter().map(String::as_str));
        run(&root, &args)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_opened_records_without_splitting_values() {
        let data = "... depotFile //depot/a file.cs\n... clientFile //client/a file.cs\n... action edit\n... change default\n\n... depotFile //depot/b.cs\n... action add\n... change 123\n";
        let parsed = records(data, "depotFile");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["depotFile"], "//depot/a file.cs");
        assert_eq!(parsed[1]["change"], "123");
    }

    #[test]
    fn rejects_filespec_expansion_and_outside_paths() {
        let root = std::env::current_dir().unwrap();
        for path in ["", "*", "foo/...", "foo#3", "foo@change", "foo%23bar"] {
            assert!(exact_file(&root, path).is_err(), "accepted {path}");
        }
        assert!(exact_file(&root.join("src"), &root.join("Cargo.toml").to_string_lossy()).is_err());
    }

    #[test]
    fn compares_have_to_unsaved_text_and_rejects_binary() {
        assert!(compare_have(b"a\r\nb\r\n", "a\nb\n").unwrap().is_empty());
        let hunks = compare_have(b"a\nb\nc\n", "a\nchanged\nc\n").unwrap();
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].old_text, "b\n");
        assert!(compare_have(b"a\0b", "changed").is_err());
        assert!(compare_have(&[0xff], "changed").is_err());
    }
}
