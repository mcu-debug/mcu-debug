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

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=MDBG_BUILD");

    // An explicit value wins, so a release pipeline building from an exported tree (no `.git`)
    // can still stamp something meaningful. `build-binaries.sh prod` always sets it, which also
    // keeps release builds incremental: with only the env trigger, cargo reruns this script --
    // and so recompiles the crate -- only when the stamp itself changes.
    if let Some(build) = std::env::var("MDBG_BUILD").ok().filter(|s| !s.is_empty()) {
        println!("cargo:rustc-env=MDBG_BUILD={build}");
        return;
    }

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

    println!("cargo:rustc-env=MDBG_BUILD={}", git_describe());
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
