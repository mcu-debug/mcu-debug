// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0

//! Keep the proxy's log directory from growing without bound.
//!
//! Two kinds of file land there, with opposite problems, so one retention rule cannot serve both.
//! Measured on a development machine after four days:
//!
//! | | count | total | median |
//! | --- | --- | --- | --- |
//! | `proxy-helper*.log` | 147 | 1.9 MB | **157 bytes** |
//! | `rsp-trace-*.txt` | 57 | **272.6 MB** | 2 MB |
//!
//! The traces were 99.3% of the bytes; the logs were all of the clutter. Nearly every log was a
//! single line -- `Reusing existing proxy for 'dev' (pid 1752, port 59394)` -- because a launch that
//! defers to a running proxy still opens a log, writes that, and exits.
//!
//! So logs are aged out and capped by count: 1.9 MB is not a size problem, and a count-first rule
//! would be actively wrong, since at ~70 files a day a small cap throws away the history of *which
//! proxy ran when*, which is the one thing these files are for. Traces are held to a byte budget
//! instead, because a single one reached 56 MB and an age rule alone could leave half a gigabyte.
//!
//! **Ages are measured by modification time, never creation time.** A proxy that has been up for a
//! week has a log created a week ago and written to a second ago. On mtime it is young and safe; on
//! creation time this function would delete the running daemon's own log out from under it.
//!
//! **mtime only means that if something keeps it fresh**, because rotation is lazy:
//! `Criterion::Age(Age::Day)` is evaluated when something writes, so a proxy that sits idle past the
//! age limit never rotates and its *current, open* log keeps a stale mtime. Unlinking that leaves
//! the daemon writing into an unlinked inode with its logging silently gone -- a miserable thing to
//! debug. Production proxies idle-exit before that; a development one never does.
//!
//! So the daemon emits a line every [`HEARTBEAT`] (see [`spawn_heartbeat`]) and mtime becomes what
//! this policy already assumed it was: **the last sign of life**. That is deliberately a fix to the
//! invariant rather than an exception to it. The alternative was to read the singleton's
//! `endpoint.json` files, parse a pid out of every filename and spare anything still running --
//! fifty lines, a coupling to the singleton, and a second definition of "alive" to keep true.
//!
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Log files older than this are removed.
const LOG_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// Backstop for the age rule, so one pathological day cannot fill the directory.
const LOG_MAX_FILES: usize = 500;
/// Traces older than this are removed regardless of the budget: a trace is useful while you are
/// still debugging what produced it, and not much past that.
const TRACE_MAX_AGE: Duration = Duration::from_secs(2 * 24 * 60 * 60);
/// Newest traces are kept until their total reaches this.
const TRACE_MAX_BYTES: u64 = 200 * 1024 * 1024;

/// What a sweep removed, for the one log line that reports it.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub files: usize,
    pub bytes: u64,
}

impl Swept {
    fn add(&mut self, bytes: u64) {
        self.files += 1;
        self.bytes += bytes;
    }
    fn is_empty(&self) -> bool {
        self.files == 0
    }
}

struct Entry {
    path: PathBuf,
    bytes: u64,
    age: Duration,
}

/// List one kind of file, newest first, skipping anything we cannot stat.
///
/// `now` is passed in rather than read per entry so a sweep cannot classify two files
/// inconsistently, and so tests can choose it.
fn collect(dir: &Path, prefix: &str, now: SystemTime) -> Vec<Entry> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(prefix) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        // mtime, not created(): see the module note. `created` is also unavailable on some
        // filesystems, which would silently exempt files from cleanup.
        let age = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .unwrap_or_default();
        out.push(Entry {
            path: entry.path(),
            bytes: meta.len(),
            age,
        });
    }
    out.sort_by_key(|e| e.age);
    out
}

/// Remove `path`, counting it only if it actually went.
fn remove(path: &Path, bytes: u64, swept: &mut Swept) {
    match fs::remove_file(path) {
        Ok(()) => swept.add(bytes),
        // Not worth a warning: a concurrent sweep from another instance, or a file another process
        // still holds open, are both ordinary. The next sweep will try again.
        Err(e) => log::debug!("log cleanup: could not remove {}: {e}", path.display()),
    }
}

/// Sweep the directory. Safe to call concurrently with another proxy doing the same.
pub fn sweep(dir: &Path) -> Swept {
    sweep_with(
        dir,
        SystemTime::now(),
        LOG_MAX_AGE,
        LOG_MAX_FILES,
        TRACE_MAX_AGE,
        TRACE_MAX_BYTES,
    )
}

/// The policy, with every limit injected so a test does not have to wait two days.
#[allow(clippy::too_many_arguments)]
fn sweep_with(
    dir: &Path,
    now: SystemTime,
    log_max_age: Duration,
    log_max_files: usize,
    trace_max_age: Duration,
    trace_max_bytes: u64,
) -> Swept {
    let mut swept = Swept::default();

    // Logs: age first, then the count backstop against what age left behind.
    let logs = collect(dir, "proxy-helper", now);
    let mut kept = 0usize;
    for e in &logs {
        if e.age > log_max_age || kept >= log_max_files {
            remove(&e.path, e.bytes, &mut swept);
        } else {
            kept += 1;
        }
    }

    // Traces: age, then keep newest-first until the budget is spent. Age is applied first so a
    // stale trace cannot occupy budget that a current one needs.
    let traces = collect(dir, "rsp-trace", now);
    let mut used = 0u64;
    for e in &traces {
        if e.age > trace_max_age || used + e.bytes > trace_max_bytes {
            remove(&e.path, e.bytes, &mut swept);
        } else {
            used += e.bytes;
        }
    }

    swept
}

/// How often the daemon proves it is alive.
///
/// Six hours rather than a day: it costs 1460 lines a year, and leaves a 56x margin against
/// [`LOG_MAX_AGE`], so a live proxy's log is never close to looking stale.
pub const HEARTBEAT: Duration = Duration::from_secs(6 * 60 * 60);

/// Hours and minutes. Enough to see at a glance how long a daemon has been up.
fn uptime(d: Duration) -> String {
    let mins = d.as_secs() / 60;
    format!("{}h {}m", mins / 60, mins % 60)
}

/// The heartbeat line.
///
/// **It must differ from the previous one**, which is why the uptime is in it. `DedupFilter`
/// collapses consecutive identical messages, and on a daemon logging nothing else the heartbeat is
/// every message -- so a constant string would be held as a repeat and defeat the one thing the
/// heartbeat exists to do.
fn heartbeat_line(up: Duration) -> String {
    format!("proxy alive, up {}", uptime(up))
}

/// Keep this process's log mtime fresh for as long as it lives.
///
/// A detached thread, like the lifetime watchers: it only sleeps, and the process exiting takes it.
pub fn spawn_heartbeat() {
    std::thread::spawn(|| {
        let started = std::time::Instant::now();
        loop {
            std::thread::sleep(HEARTBEAT);
            log::info!("{}", heartbeat_line(started.elapsed()));
        }
    });
}

/// Sweep and say so, once, at startup.
///
/// Called only by the process that won the singleton election -- the one moment we know we are the
/// long-lived instance. A launch that defers to a running proxy has already returned by then, and
/// those are the common case, so the sweep does not run on the path that creates most of the files.
pub fn sweep_and_report(dir: &Path) {
    let swept = sweep(dir);
    if !swept.is_empty() {
        log::info!(
            "Log cleanup: removed {} file(s), {:.1} MB from {}",
            swept.files,
            swept.bytes as f64 / (1024.0 * 1024.0),
            dir.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    fn write(dir: &Path, name: &str, bytes: usize, age: Duration) {
        let path = dir.join(name);
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(&vec![b'x'; bytes]).unwrap();
        drop(f);
        let mtime = SystemTime::now() - age;
        // `set_times` so the test exercises the same `modified()` the policy reads.
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(mtime))
            .unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn run(dir: &Path) -> Swept {
        sweep_with(dir, SystemTime::now(), 14 * DAY, 500, 2 * DAY, 200 * 1024 * 1024)
    }

    #[test]
    fn an_old_log_goes_and_a_recent_one_stays() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "proxy-helper_1-1_rCURRENT.log", 157, 20 * DAY);
        write(d.path(), "proxy-helper_2-2_rCURRENT.log", 157, 1 * DAY);
        let swept = run(d.path());
        assert_eq!(swept.files, 1);
        assert_eq!(names(d.path()), vec!["proxy-helper_2-2_rCURRENT.log"]);
    }

    #[test]
    fn a_log_written_seconds_ago_survives_however_old_the_file_is() {
        // The destructive mistake this policy avoids: a proxy up for a month has a log *created* a
        // month ago and *modified* now. On creation time this sweep would delete the running
        // daemon's own log; on mtime it is the youngest file there.
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "proxy-helper_live_rCURRENT.log",
            300_000,
            Duration::from_secs(1),
        );
        assert_eq!(run(d.path()), Swept::default());
        assert_eq!(names(d.path()).len(), 1);
    }

    #[test]
    fn the_count_cap_keeps_the_newest() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..10u32 {
            write(
                d.path(),
                &format!("proxy-helper_{i}_rCURRENT.log"),
                157,
                Duration::from_secs(u64::from(i) * 60),
            );
        }
        let swept = sweep_with(d.path(), SystemTime::now(), 14 * DAY, 4, 2 * DAY, u64::MAX);
        assert_eq!(swept.files, 6);
        // Ages were 0,60,120,... so the four kept are 0..3.
        assert_eq!(
            names(d.path()),
            vec![
                "proxy-helper_0_rCURRENT.log",
                "proxy-helper_1_rCURRENT.log",
                "proxy-helper_2_rCURRENT.log",
                "proxy-helper_3_rCURRENT.log"
            ]
        );
    }

    #[test]
    fn traces_are_held_to_a_byte_budget_newest_first() {
        // Why traces get a budget and not just an age: one of these was 56 MB in the field, and a
        // week of them under an age rule alone is half a gigabyte.
        let d = tempfile::tempdir().unwrap();
        for i in 0..5u32 {
            write(
                d.path(),
                &format!("rsp-trace-gdbPort-{i}.txt"),
                1000,
                Duration::from_secs(u64::from(i) * 60),
            );
        }
        let swept = sweep_with(d.path(), SystemTime::now(), 14 * DAY, 500, 2 * DAY, 2500);
        assert_eq!(swept.files, 3, "two fit in 2500 bytes");
        assert_eq!(
            names(d.path()),
            vec!["rsp-trace-gdbPort-0.txt", "rsp-trace-gdbPort-1.txt"]
        );
    }

    #[test]
    fn a_stale_trace_does_not_occupy_budget_a_current_one_needs() {
        // Age is applied before the budget for this reason.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "rsp-trace-gdbPort-old.txt", 2000, 10 * DAY);
        write(d.path(), "rsp-trace-gdbPort-new.txt", 2000, Duration::from_secs(60));
        let swept = sweep_with(d.path(), SystemTime::now(), 14 * DAY, 500, 2 * DAY, 2500);
        assert_eq!(swept.files, 1);
        assert_eq!(names(d.path()), vec!["rsp-trace-gdbPort-new.txt"]);
    }

    #[test]
    fn one_oversized_trace_is_removed_rather_than_kept_forever() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "rsp-trace-gdbPort-huge.txt", 5000, Duration::from_secs(60));
        let swept = sweep_with(d.path(), SystemTime::now(), 14 * DAY, 500, 2 * DAY, 1000);
        assert_eq!(swept.files, 1, "a file that cannot fit the budget alone still goes");
        assert!(names(d.path()).is_empty());
    }

    #[test]
    fn the_two_kinds_are_swept_under_their_own_rules() {
        // A log is kept at an age that removes a trace, which is the whole point of two policies.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "proxy-helper_a_rCURRENT.log", 157, 5 * DAY);
        write(d.path(), "rsp-trace-gdbPort-a.txt", 157, 5 * DAY);
        let swept = run(d.path());
        assert_eq!(swept.files, 1);
        assert_eq!(names(d.path()), vec!["proxy-helper_a_rCURRENT.log"]);
    }

    #[test]
    fn unrelated_files_are_never_touched() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "something-else.log", 10, 100 * DAY);
        write(d.path(), "endpoint.json", 10, 100 * DAY);
        assert_eq!(run(d.path()), Swept::default());
        assert_eq!(names(d.path()).len(), 2);
    }

    #[test]
    fn a_missing_directory_is_not_an_error() {
        assert_eq!(sweep(Path::new("/no/such/mcu-debug/log/dir")), Swept::default());
    }

    #[test]
    fn the_heartbeat_keeps_a_live_log_inside_the_age_limit() {
        // The property the whole policy rests on: a proxy logging nothing else still writes often
        // enough that its open log is never a cleanup candidate.
        assert!(HEARTBEAT * 2 < LOG_MAX_AGE, "a missed beat must not age a log out");
        assert!(
            HEARTBEAT.as_secs() * 56 <= LOG_MAX_AGE.as_secs(),
            "and the margin should be large, not marginal"
        );
    }

    #[test]
    fn consecutive_heartbeats_are_not_identical() {
        // `DedupFilter` holds a repeat of the previous message. On an otherwise-silent daemon the
        // heartbeat is every message, so a constant string would be suppressed, mtime would go stale
        // anyway, and the heartbeat would do nothing at all.
        let a = heartbeat_line(HEARTBEAT);
        let b = heartbeat_line(HEARTBEAT * 2);
        assert_ne!(a, b, "{a} vs {b}");
    }

    #[test]
    fn uptime_reads_as_hours_and_minutes() {
        assert_eq!(uptime(Duration::from_secs(0)), "0h 0m");
        assert_eq!(uptime(Duration::from_secs(90 * 60)), "1h 30m");
        assert_eq!(uptime(14 * DAY), "336h 0m");
    }
}
