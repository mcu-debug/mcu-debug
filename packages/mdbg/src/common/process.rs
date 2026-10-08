// Copyright (c) 2026 MCU-Debug Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Cross-platform helpers around [`std::process::Command`].

use std::process::{Child, Command};
use std::time::Duration;

/// Windows: prevent a console-subsystem child (gdb-server, netstat, objdump, node, ...)
/// from popping up its own console window.
///
/// When a process with no console of its own (e.g. this proxy, which was launched
/// detached — see `proxy_helper::run::detach_process`) spawns a console-subsystem
/// child without any console-related creation flag, Windows allocates a brand-new,
/// visible console for that child. That is the flash you see on screen, and since
/// some of these commands run on a poll loop (see `port_monitor`), it can repeat.
///
/// `CREATE_NO_WINDOW` still gives the child a real (hidden) console — unlike
/// `DETACHED_PROCESS`, which gives it none — so console APIs and control events
/// (e.g. `GenerateConsoleCtrlEvent` for Ctrl+C/Break shutdown) keep working for the
/// child. That matters here because these children are piped and/or need to be
/// signaled, not fully detached background daemons.
///
/// No-op on non-Windows platforms.
pub fn suppress_console_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Unix: start the child as the leader of a process group of its own, so that it -- and everything
/// *it* starts -- can be stopped together with [`terminate_process_tree`].
///
/// Without this a gdb-server lands in our own group, and whatever it launches is out of reach once it
/// is gone: pyavrocd starts `simavr`, and killing pyavrocd orphaned simavr with the gdb port still
/// open. (Killing *our* group instead would have taken the proxy down with it.)
///
/// The child no longer shares the terminal's foreground group, so a Ctrl-C typed at a terminal
/// reaches only us; stopping the child is then our job, which `terminate_process_tree` does.
///
/// No-op on Windows, which has no process groups; a Job Object would be its equivalent.
pub fn own_process_group(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// Stop a child started with [`own_process_group`], and everything in its group.
///
/// `SIGTERM` to the group first, so a gdb-server can release the probe and stop its own children;
/// then, once the leader has exited or `grace` has passed, `SIGKILL` to the group regardless, so
/// nothing outlives it -- a member that ignored `SIGTERM`, or one whose parent was killed before it
/// could pass the signal on. `killpg` still reaches members after the leader itself has gone.
///
/// A process that deliberately left the group (`setsid`, daemonizing) escapes; only cgroups would
/// catch that. On Windows this kills the direct child only.
pub fn terminate_process_tree(child: &mut Child, grace: Duration) {
    #[cfg(unix)]
    {
        // The group id is the leader's pid. Only ever positive, so this can never mean "our own
        // group" (0) or "every process we may signal" (-1).
        let pgid = child.id() as libc::pid_t;
        if pgid > 0 {
            // SAFETY: killpg takes plain integers and has no memory-safety preconditions.
            unsafe { libc::killpg(pgid, libc::SIGTERM) };
            let deadline = std::time::Instant::now() + grace;
            while matches!(child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            // SAFETY: as above. ESRCH (group already empty) is the expected, harmless outcome.
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
    }
    #[cfg(not(unix))]
    let _ = grace;
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// The pyavrocd/simavr shape: a child that starts its own child. Stopping the child must stop
    /// the grandchild too, which a plain `Child::kill` does not.
    #[test]
    fn a_grandchild_dies_with_its_parent() {
        let mut cmd = Command::new("sh");
        // `sh` prints its child's pid, then waits on it like a gdb-server waiting on its simulator.
        cmd.args(["-c", "sleep 60 & echo $!; wait"])
            .stdout(std::process::Stdio::piped());
        own_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");

        let mut line = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(child.stdout.take().unwrap()), &mut line).unwrap();
        let grandchild: i32 = line.trim().parse().expect("grandchild pid");
        assert!(alive(grandchild), "grandchild should be running");

        terminate_process_tree(&mut child, Duration::from_secs(2));

        // Reaped by init once orphaned, so give it a moment to disappear.
        let deadline = Instant::now() + Duration::from_secs(2);
        while alive(grandchild) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(grandchild), "the grandchild outlived its parent");
    }

    /// The group is the child's, not ours: tearing it down must not touch this process.
    #[test]
    fn the_group_is_the_childs_not_ours() {
        let mut cmd = Command::new("sleep");
        cmd.arg("60");
        own_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sleep");
        // SAFETY: getpgid only reads the process table.
        let child_pgid = unsafe { libc::getpgid(child.id() as libc::pid_t) };
        let our_pgid = unsafe { libc::getpgrp() };
        assert_eq!(
            child_pgid,
            child.id() as libc::pid_t,
            "the child must lead its own group"
        );
        assert_ne!(child_pgid, our_pgid);
        terminate_process_tree(&mut child, Duration::from_secs(1));
    }
}
