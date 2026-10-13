// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0
//
//! Stamps the build with the commit it came from.
//!
//! This exists because `CARGO_PKG_VERSION` cannot answer the question that actually costs time:
//! *am I talking to the binary I just built?* The version is bumped per release, so every build
//! between two releases reports the same string -- which is exactly the situation during
//! development, and exactly when a stale process is most likely. Two cases seen in one evening:
//! a daemonised Agent still serving a binary that had been replaced on disk (`MDBG_PROXY_IDLE_TIMEOUT=0`
//! means it never exits to pick up a rebuild), and a debug adapter reused through
//! `"debugServer"` from hours earlier. Both reported 0.1.18 and both were wrong.
//!
//! The format matches `packages/mcu-debug/scripts/commit-hash.js` so the two sides of a session
//! print comparable strings: short hash, plus `+dirty` when the tree had uncommitted changes.
//!
//! On Windows targets it also embeds a version resource, so Windows names the program properly:
//! the firewall prompt, Task Manager and the file's Properties show "MCU Debug Agent" rather than
//! just the file name.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=MDBG_BUILD");

    // An explicit value wins, so a release pipeline building from an exported tree (no `.git`)
    // can still stamp something meaningful. `build-binaries.sh prod` always sets it, which also
    // keeps release builds incremental: with only the env trigger, cargo reruns this script --
    // and so recompiles the crate -- only when the stamp itself changes.
    let build = match std::env::var("MDBG_BUILD").ok().filter(|s| !s.is_empty()) {
        Some(build) => build,
        None => {
            watch_git();
            git_describe()
        }
    };
    println!("cargo:rustc-env=MDBG_BUILD={build}");
    windows_version_resource(&build);
}

/// Rerun when the commit moves -- see the comment inside for why only these paths.
fn watch_git() {
    // Rerun when the commit moves: HEAD (branch switch), the branch refs (commit, reset), and
    // packed-refs. Deliberately NOT `.git/index`. Git rewrites the index whenever any command
    // refreshes its stat cache -- `git status` here and in commit-hash.js, the editor's git
    // integration, a file merely touched with identical content -- so watching it recompiled the
    // crate on nearly every build while the stamp stayed the same.
    //
    // The cost: `+dirty` is the tree's state when the commit last moved, so it can lag. That is
    // harmless -- both sides compare builds with `+dirty` stripped (`singleton::strip_dirty`,
    // `session-identity.ts`) -- and npm-driven release builds get an exact value via MDBG_BUILD.
    for git_path in ["HEAD", "refs/heads", "packed-refs"] {
        if let Some(path) = git_path_of(git_path) {
            // A path that does not exist would make cargo rerun this script on every build.
            if std::path::Path::new(&path).exists() {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
}

/// Windows targets only: embed a VERSIONINFO resource. Without one, the firewall prompt names the
/// program by its file name alone, which tells a user nothing about whether to trust it.
///
/// `embed-resource` picks the compiler: the target-prefixed `windres` when cross-compiling (the
/// mingw toolchain, or `cross`'s container), `rc.exe` for MSVC. A machine without one (a Windows
/// dev box with no SDK) gets a warning and a binary without the resource -- never a failed build.
///
/// The `.rc` file is written only when its contents change: `embed-resource` watches it, and a
/// fresh mtime on every run would recompile the crate on every build.
fn windows_version_resource(build: &str) {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let num = |name: &str| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(0)
    };
    let (major, minor, patch) = (
        num("CARGO_PKG_VERSION_MAJOR"),
        num("CARGO_PKG_VERSION_MINOR"),
        num("CARGO_PKG_VERSION_PATCH"),
    );
    let version = env!("CARGO_PKG_VERSION");
    // `"` would end an RC string; nothing we put here should contain one, but never emit a broken file.
    let text = |s: &str| s.replace('"', "'");
    let rc = format!(
        r#"#include <winver.h>
1 VERSIONINFO
FILEVERSION {major},{minor},{patch},0
PRODUCTVERSION {major},{minor},{patch},0
FILEOS VOS_NT_WINDOWS32
FILETYPE VFT_APP
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "MCU-Debug Authors"
      VALUE "FileDescription", "MCU Debug Agent"
      VALUE "FileVersion", "{version} ({build})"
      VALUE "InternalName", "mcu-debug-agent"
      VALUE "LegalCopyright", "Copyright (c) 2026 MCU-Debug Authors. Apache-2.0"
      VALUE "OriginalFilename", "mcu-debug-agent.exe"
      VALUE "ProductName", "MCU Debug"
      VALUE "ProductVersion", "{version}"
      VALUE "Comments", "Probe Agent, debug-adapter helper and CLI for the MCU Debug VS Code extension"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x0409, 1200
  END
END
"#,
        version = text(version),
        build = text(build),
    );
    let out = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("version.rc");
    if std::fs::read_to_string(&out).ok().as_deref() != Some(rc.as_str()) {
        std::fs::write(&out, &rc).expect("write version.rc");
    }
    if let Err(e) = embed_resource::compile(&out, embed_resource::NONE).manifest_optional() {
        println!("cargo:warning=no Windows version resource embedded ({e}); the binary works, but Windows will show only its file name");
    }
}

/// Where git keeps `rel`, resolved by git itself so linked worktrees (where `.git` is a file)
/// work too. `None` without a usable git.
fn git_path_of(rel: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-path", rel])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// Short hash plus `+dirty`, or `"unknown"` when there is no usable git.
///
/// Never fails the build: a missing `git`, or a source tarball with no repository, is a normal way
/// to compile this and is not worth refusing. `"unknown"` is still useful -- it says "this binary
/// cannot tell you", which is different from claiming a hash it does not have.
fn git_describe() -> String {
    let hash = Command::new("git").args(["rev-parse", "--short", "HEAD"]).output();
    let Ok(out) = hash else {
        return "unknown".to_string();
    };
    if !out.status.success() {
        return "unknown".to_string();
    }
    let hash = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if hash.is_empty() {
        return "unknown".to_string();
    }
    let dirty = Command::new("git")
        .args(["status", "--short"])
        .output()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false);
    if dirty {
        format!("{hash}+dirty")
    } else {
        hash
    }
}
