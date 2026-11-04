import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorRegistry } from "@/editor/api";
import { formatMessage, useTx } from "@/platform/i18n";
import { useProjectVcs } from "@/platform/projectVcs";
import styles from "./PerforceView.module.css";

type P4Info = { client: string; user: string; root: string; server: string };
type OpenedFile = { path: string; depot: string; action: string; change: string };

export function PerforceToolWindow() {
  const provider = useProjectVcs((s) => s.provider);
  if (provider !== "perforce") return <p>Select Perforce in Settings → Version Control → Directory Mappings to use this panel.</p>;
  return <PerforcePanel />;
}

function PerforcePanel() {
  const tx = useTx();
  const currentPath = useEditorRegistry((state) => state.active?.ctx.path ?? null);
  const [info, setInfo] = useState<P4Info | null>(null);
  const [files, setFiles] = useState<OpenedFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const [workspace, opened] = await Promise.all([
        invoke<P4Info>("p4_info"), invoke<OpenedFile[]>("p4_opened"),
      ]);
      setInfo(workspace); setFiles(opened);
       setSelected((previous) => previous.filter((path) => opened.some((file) => file.path === path && file.change === "default")));
    } catch (e) { setError(errorMessage(e)); setInfo(null); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!active) { setDiff(""); return; }
    let live = true;
    setDiff(""); setDiffPath(null); setError("");
    invoke<string>("p4_diff", { path: active }).then((value) => { if (live) { setDiff(value); setDiffPath(active); } })
      .catch((e) => { if (live) { setDiff(""); setDiffPath(null); setError(errorMessage(e)); } });
    return () => { live = false; };
  }, [active]);

  const selectedFiles = useMemo(() => files.filter((file) => selected.includes(file.path)), [files, selected]);
  const toggle = (path: string) => {
    if (files.find((file) => file.path === path)?.change !== "default") return;
    setSelected((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  };
  const selectDiff = (path: string) => {
    if (path === active) return;
    setDiff(""); setDiffPath(null); setError(""); setActive(path);
  };
  const edit = async (path: string) => {
    setBusy(true); setError("");
    try { await invoke("p4_edit", { path }); setNotice(formatMessage(tx("Checked out {name}"), { name: path })); await refresh(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!selectedFiles.length || !description.trim()) return;
    const paths = selectedFiles.map((file) => file.path);
    if (!window.confirm(formatMessage(tx("Submit exactly these {count} selected file(s) from the default changelist?\n\n{paths}\n\nOnly these existing opened files will be submitted. Numbered changelists, stream specs, deleted files, and paths containing Perforce special characters are not supported."), { count: paths.length, paths: paths.join("\n") }))) return;
    setBusy(true); setError("");
    try {
      setNotice(await invoke<string>("p4_submit", { paths, description: description.trim() }));
      setDescription(""); setSelected([]); await refresh();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return <main className={styles.root}>
    <header className={styles.heading}><div><span className={styles.eyebrow}>{tx("VERSION CONTROL")}</span><h2>Perforce</h2></div><button onClick={() => void refresh()} disabled={busy} aria-label={tx("Refresh opened files")}>↻</button></header>
    {info ? <section className={styles.workspace} aria-label={tx("Workspace details")}><div><span>{tx("WORKSPACE")}</span><strong>{info.client}</strong></div><div><span>{tx("USER")}</span><strong>{info.user}</strong></div><div className={styles.rootPath}><span>{tx("ROOT")}</span><strong title={info.root}>{info.root}</strong></div><div className={styles.server}><span>{tx("SERVER")}</span><strong title={info.server}>{info.server}</strong></div></section> : <p className={styles.empty}>{tx("Connect to a Perforce workspace to discover its files.")}</p>}
    {error && <p className={styles.error} role="alert">{formatMessage(tx("Perforce connection or operation failed: {error}"), { error })}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <section className={styles.checkout} aria-label={tx("Check out current editor file")}><div><strong>{tx("Current editor file")}</strong><span>{currentPath ?? tx("No file is active in the editor.")}</span></div><button className={styles.edit} disabled={busy || !currentPath} title={tx(currentPath ? "Check out the current editor file" : "Open a project file in the editor to enable checkout")} onClick={() => currentPath && void edit(currentPath)}>{tx("Check out current file")}</button></section>
    <div className={styles.scopeNotice} role="note"><strong>{tx("Supported scope")}</strong><span>{tx("Only files opened in this project are listed. Submit supports existing files in the default changelist only; numbered changelists, stream specs, deleted files, and paths containing Perforce special characters are excluded.")}</span></div>
    <div className={styles.sectionTitle}><h3>{tx("Opened files")}</h3><span>{files.length}</span></div>
    <div className={styles.fileList} role="list" aria-label="Opened files">{files.map((file) => <div key={file.path} className={`${styles.file} ${active === file.path ? styles.active : ""}`}>
      <input type="checkbox" checked={selected.includes(file.path)} disabled={file.change !== "default"} onChange={() => toggle(file.path)} aria-label={tx`Include ${file.path} in submit`} title={file.change !== "default" ? tx("Only default-changelist files can be selected for submit.") : undefined} />
      <button className={styles.fileName} onClick={() => selectDiff(file.path)} title={file.path}><strong>{file.path.split(/[\\/]/).pop()}</strong><small>{file.path}</small></button>
      <span className={styles.action}>{file.action}</span>
    </div>)}{!files.length && <p className={styles.empty}>{tx("No opened files in this workspace.")}</p>}</div>
    <section className={styles.diffSection}><div className={styles.sectionTitle}><h3>{tx("Diff")}</h3><span>{active ? active.split(/[\\/]/).pop() : tx("Select a file")}</span></div><pre className={styles.diff}>{diffPath === active && diff ? diff : active ? tx("No diff available.") : tx("Choose a file above to inspect its diff.")}</pre></section>
    <section className={styles.submitSection}><div className={styles.sectionTitle}><h3>{tx("Submit selected default-changelist files")}</h3><span>{formatMessage(tx("{count} selected"), { count: selectedFiles.length })}</span></div><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={tx("Describe this change")} aria-label={tx("Submit description")} rows={3} />
      {selectedFiles.length > 0 && <div className={styles.selection}><strong>{tx("Files to submit")}</strong>{selectedFiles.map((file) => <span key={file.path}>{file.path}</span>)}</div>}
      <button className={styles.submit} disabled={busy || !selectedFiles.length || !description.trim()} onClick={() => void submit()}>{tx("Submit selected files")}</button>
    </section>
  </main>;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : String(error);
}
