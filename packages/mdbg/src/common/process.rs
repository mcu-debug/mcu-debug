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

use std::process::Command;

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
