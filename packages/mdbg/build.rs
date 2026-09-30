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
    // Rerun when the commit moves or the index changes. A working-tree edit does not retrigger
    // this script, so `+dirty` can lag by one build -- acceptable, because any such edit rebuilds
    // the crate anyway and the hash it is compared against is the one that matters.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/index");
    println!("cargo:rerun-if-env-changed=MDBG_BUILD");

    // An explicit value wins, so a release pipeline building from an exported tree (no `.git`)
    // can still stamp something meaningful.
    let build = std::env::var("MDBG_BUILD")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(git_describe);
    println!("cargo:rustc-env=MDBG_BUILD={build}");
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
