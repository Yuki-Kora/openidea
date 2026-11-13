use super::RawProcess;
use ide_core::{IdeError, IdeResult};
use std::io;
use std::mem::{MaybeUninit, size_of};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::ptr::null_mut;
use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE, UNICODE_STRING};
use windows_sys::Win32::Security::{
    GetLengthSid, GetTokenInformation, SECURITY_MAX_SID_SIZE, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, MODULEENTRY32W, Module32FirstW, Module32NextW, PROCESSENTRY32W, Process32FirstW,
    Process32NextW, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};

fn list_error(error: io::Error) -> IdeError {
    IdeError::unavailable(format!("cannot list processes: {error}"))
}

/// The current user's processes (without this one).
pub fn list_processes() -> IdeResult<Vec<RawProcess>> {
    // SAFETY: the pseudo-handle is borrowed and the snapshot handle is owned below.
    let owner = user_sid(unsafe { GetCurrentProcess() }).map_err(list_error)?;
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(list_error(io::Error::last_os_error()));
    }
    // SAFETY: a successful snapshot must be closed with CloseHandle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let me = std::process::id();
    let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut processes = Vec::new();
    // SAFETY: the entry is writable and its size is set for both enumeration calls.
    let mut more = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while more != 0 {
        let pid = entry.th32ProcessID;
        if pid != 0
            && pid != me
            && let Some(process) = process_info(pid, &owner)
        {
            processes.push(process);
        }
        more = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
        return Err(list_error(error));
    }
    Ok(processes)
}

pub(super) fn has_coreclr(pid: u32) -> bool {
    // SAFETY: a successful module snapshot is owned and closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) };
    if snapshot == INVALID_HANDLE_VALUE {
        return false;
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = MODULEENTRY32W { dwSize: size_of::<MODULEENTRY32W>() as u32, ..Default::default() };
    // SAFETY: the entry is writable and its size is set for both enumeration calls.
    let mut more = unsafe { Module32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while more != 0 {
        let len = entry.szModule.iter().position(|&unit| unit == 0).unwrap_or(entry.szModule.len());
        if String::from_utf16_lossy(&entry.szModule[..len]).eq_ignore_ascii_case("coreclr.dll") {
            return true;
        }
        more = unsafe { Module32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    false
}

fn process_info(pid: u32, owner: &[u8]) -> Option<RawProcess> {
    // SAFETY: OpenProcess returns an owned handle, or null if the process exited or denied access.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    let process = handle.as_raw_handle();
    if user_sid(process).ok()? != owner {
        return None;
    }

    let mut path = vec![0u16; 32_768];
    let mut len = path.len() as u32;
    // SAFETY: the buffer can hold `len` UTF-16 units and is writable.
    if unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut len) } == 0 {
        return None;
    }
    let exe = String::from_utf16_lossy(&path[..len as usize]);
    let args = command_line(process).unwrap_or_else(|| exe.clone());
    Some(RawProcess { pid, exe, args })
}

fn user_sid(process: RawHandle) -> io::Result<Vec<u8>> {
    let mut token = null_mut();
    // SAFETY: `process` is a live handle and `token` is valid output storage.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut buffer = MaybeUninit::<(TOKEN_USER, [u8; SECURITY_MAX_SID_SIZE as usize])>::uninit();
    let mut len = 0;
    // SAFETY: aligned storage has space for TOKEN_USER and the largest possible SID.
    unsafe {
        if GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &mut len,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let sid = (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid;
        Ok(std::slice::from_raw_parts(sid.cast::<u8>(), GetLengthSid(sid) as usize).to_vec())
    }
}

fn command_line(process: RawHandle) -> Option<String> {
    let mut len = 0;
    // SAFETY: the first call queries the required size, then Windows fills aligned storage.
    unsafe {
        NtQueryInformationProcess(process, ProcessCommandLineInformation, null_mut(), 0, &mut len);
        if (len as usize) < size_of::<UNICODE_STRING>() {
            return None;
        }
        let mut buffer = vec![0usize; (len as usize).div_ceil(size_of::<usize>())];
        if NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer.as_mut_ptr().cast(), len, &mut len)
            < 0
        {
            return None;
        }
        let line = &*buffer.as_ptr().cast::<UNICODE_STRING>();
        let offset = line.Buffer.addr().checked_sub(buffer.as_ptr().addr())?;
        let byte_len = usize::from(line.Length);
        if !offset.is_multiple_of(2)
            || !byte_len.is_multiple_of(2)
            || offset.checked_add(byte_len)? > size_of_val(buffer.as_slice())
        {
            return None;
        }
        let start = buffer.as_ptr().cast::<u8>().add(offset).cast::<u16>();
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(start, byte_len / 2)))
    }
}
