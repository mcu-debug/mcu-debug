// Copyright (c) 2026 MCU-Debug Authors.
// SPDX-License-Identifier: Apache-2.0

//! Collapse a repeating log message into one line plus a count.
//!
//! A gdb-server that loses its USB connection does not fail once; it fails as fast as it can be
//! asked, and every failure looks identical. OpenOCD in that state fills a log faster than it can
//! be read, and the one thing the reader needs -- *when did this start, and is it still going* --
//! is buried in a hundred thousand identical lines.
//!
//! Suppressing the repeats alone would lose that information rather than surface it. So a run of
//! identical messages is reported as the first line, written immediately with its own timestamp,
//! followed by a summary naming how many more there were, over what span, and when the last one
//! arrived. Two timestamps and a count describe the whole run.
//!
//! **The summary is also emitted while the run is still going**, every [`MAX_HOLD`], because a
//! message that repeats for ten minutes and then stops would otherwise produce nothing at all until
//! it stopped -- the opposite of what a reader watching a live log needs. An interim summary doubles
//! as a rate: "repeated 12000 more times over 5.0s" says more about a firehose than any single line
//! of it.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use flexi_logger::filter::{LogLineFilter, LogLineWriter};
use flexi_logger::DeferredNow;
use log::{Level, Record};

use super::sync::MutexExt;

/// How long a run may be held before an interim summary is written.
///
/// Short enough that a reader tailing the log sees movement, and that at most this much is lost if
/// the process exits mid-run. Long enough that a steady low-rate repeat does not defeat the point.
const MAX_HOLD: Duration = Duration::from_secs(5);

/// How many repeats may accumulate before a summary is written regardless of time.
///
/// Keeps the reported numbers in a range that reads as a quantity rather than a hash.
const MAX_COUNT: u64 = 10_000;

/// What identifies a message as "the same one again".
///
/// The formatted text, plus where it came from. Two different sites emitting the same words are
/// genuinely different events and are not collapsed together; the same site emitting the same words
/// is the case this exists for.
#[derive(PartialEq, Eq)]
struct Key {
    level: Level,
    target: String,
    module_path: Option<String>,
    line: Option<u32>,
    message: String,
}

struct Run {
    key: Key,
    file: Option<String>,
    /// Repeats *after* the one already written. Zero means nothing to summarise.
    extra: u64,
    first_at: Instant,
    last_at: Instant,
    last_wall: DateTime<Local>,
}

/// Collapses consecutive identical log messages. See the module documentation.
pub struct DedupFilter {
    run: Mutex<Option<Run>>,
    max_hold: Duration,
    max_count: u64,
}

impl DedupFilter {
    pub fn new() -> Self {
        Self::with_limits(MAX_HOLD, MAX_COUNT)
    }

    /// Chiefly so the hold can be driven in a test without waiting [`MAX_HOLD`] out.
    pub fn with_limits(max_hold: Duration, max_count: u64) -> Self {
        Self {
            run: Mutex::new(None),
            max_hold,
            max_count,
        }
    }

    /// `"1.2s"` or `"340ms"`. Sub-second resolution matters: it is what separates a server refusing
    /// instantly from one timing out, and those are different faults.
    fn span(d: Duration) -> String {
        let ms = d.as_millis();
        if ms < 1000 {
            format!("{ms}ms")
        } else {
            format!("{:.1}s", d.as_secs_f64())
        }
    }

    /// Write the summary for a finished or still-running run.
    ///
    /// Carries the suppressed record's own level, target and location, so the summary is formatted,
    /// filtered and attributed exactly as the lines it stands for -- a summary that arrived at a
    /// different level from the messages it counts would be worse than none.
    fn write_summary(
        run: &Run,
        still_going: bool,
        now: &mut DeferredNow,
        out: &dyn LogLineWriter,
    ) -> std::io::Result<()> {
        let tail = if still_going { ", still repeating" } else { "" };
        let text = format!(
            "last message repeated {} more time{} over {} (last at {}){tail}",
            run.extra,
            if run.extra == 1 { "" } else { "s" },
            Self::span(run.last_at.duration_since(run.first_at)),
            run.last_wall.format("%H:%M:%S%.3f"),
        );
        out.write(
            now,
            &Record::builder()
                .level(run.key.level)
                .target(&run.key.target)
                .module_path(run.key.module_path.as_deref())
                .file(run.file.as_deref())
                .line(run.key.line)
                .args(format_args!("{text}"))
                .build(),
        )
    }
}

impl Default for DedupFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl LogLineFilter for DedupFilter {
    fn write(&self, now: &mut DeferredNow, record: &Record, out: &dyn LogLineWriter) -> std::io::Result<()> {
        let key = Key {
            level: record.level(),
            target: record.target().to_owned(),
            module_path: record.module_path().map(ToOwned::to_owned),
            line: record.line(),
            message: record.args().to_string(),
        };
        let wall = *now.now();
        let mut guard = self.run.lock_recover();

        if let Some(run) = guard.as_mut() {
            if run.key == key {
                run.extra += 1;
                run.last_at = Instant::now();
                run.last_wall = wall;
                // Held, not dropped: an interim summary keeps a live log moving and reads as a rate.
                if run.extra >= self.max_count || run.last_at.duration_since(run.first_at) >= self.max_hold {
                    Self::write_summary(run, true, now, out)?;
                    run.extra = 0;
                    run.first_at = run.last_at;
                }
                return Ok(());
            }
            // A different message ends the run. Its summary goes out first, so the log reads in the
            // order things happened rather than ending a run after the line that interrupted it.
            if run.extra > 0 {
                Self::write_summary(run, false, now, out)?;
            }
        }

        let at = Instant::now();
        *guard = Some(Run {
            key,
            file: record.file().map(ToOwned::to_owned),
            extra: 0,
            first_at: at,
            last_at: at,
            last_wall: wall,
        });
        drop(guard);
        out.write(now, record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Collects what the filter decided to write, formatted the way the assertions need it.
    #[derive(Default)]
    struct Sink(StdMutex<Vec<(Level, String, String)>>);

    impl LogLineWriter for Sink {
        fn write(&self, _now: &mut DeferredNow, record: &Record) -> std::io::Result<()> {
            self.0
                .lock_recover()
                .push((record.level(), record.target().to_owned(), record.args().to_string()));
            Ok(())
        }
    }

    impl Sink {
        fn messages(&self) -> Vec<String> {
            self.0.lock_recover().iter().map(|(_, _, m)| m.clone()).collect()
        }
    }

    /// One log call. `line` distinguishes call sites, as a real `log!` would.
    fn emit(f: &DedupFilter, sink: &Sink, level: Level, target: &str, line: u32, msg: &str) {
        f.write(
            &mut DeferredNow::new(),
            &Record::builder()
                .level(level)
                .target(target)
                .module_path(Some("m"))
                .file(Some("f.rs"))
                .line(Some(line))
                .args(format_args!("{msg}"))
                .build(),
            sink,
        )
        .unwrap();
    }

    fn say(f: &DedupFilter, sink: &Sink, msg: &str) {
        emit(f, sink, Level::Warn, "t", 10, msg);
    }

    #[test]
    fn a_repeat_is_written_once_and_then_held() {
        let (f, sink) = (DedupFilter::new(), Sink::default());
        for _ in 0..50 {
            say(&f, &sink, "USB connection lost");
        }
        assert_eq!(
            sink.messages(),
            vec!["USB connection lost"],
            "49 repeats held, not written"
        );
    }

    #[test]
    fn a_new_message_flushes_the_summary_first() {
        // Order matters: the run ended *before* the line that interrupted it, and a log that says
        // otherwise misreports when the fault stopped.
        let (f, sink) = (DedupFilter::new(), Sink::default());
        for _ in 0..4 {
            say(&f, &sink, "same");
        }
        say(&f, &sink, "different");
        let m = sink.messages();
        assert_eq!(m.len(), 3, "{m:?}");
        assert_eq!(m[0], "same");
        assert!(m[1].starts_with("last message repeated 3 more times over "), "{}", m[1]);
        assert_eq!(m[2], "different");
    }

    #[test]
    fn the_summary_carries_the_count_the_span_and_the_last_arrival() {
        // The three things a reader needs: how many, for how long, and whether it has stopped.
        let (f, sink) = (DedupFilter::new(), Sink::default());
        for _ in 0..101 {
            say(&f, &sink, "E01");
        }
        say(&f, &sink, "done");
        let summary = &sink.messages()[1];
        assert!(summary.contains("repeated 100 more times"), "{summary}");
        assert!(summary.contains(" over "), "{summary}");
        assert!(summary.contains("(last at "), "{summary}");
        assert!(
            !summary.contains("still repeating"),
            "a finished run is not still going: {summary}"
        );
    }

    #[test]
    fn a_message_that_did_not_repeat_gets_no_summary() {
        let (f, sink) = (DedupFilter::new(), Sink::default());
        say(&f, &sink, "one");
        say(&f, &sink, "two");
        assert_eq!(sink.messages(), vec!["one", "two"], "nothing to summarise");
    }

    #[test]
    fn one_repeat_is_singular() {
        let (f, sink) = (DedupFilter::new(), Sink::default());
        say(&f, &sink, "x");
        say(&f, &sink, "x");
        say(&f, &sink, "y");
        assert!(
            sink.messages()[1].contains("repeated 1 more time over"),
            "{:?}",
            sink.messages()
        );
    }

    #[test]
    fn the_same_words_from_different_sites_are_different_events() {
        // Two call sites that happen to share wording are not one repeating fault, and collapsing
        // them would hide the second site entirely.
        let (f, sink) = (DedupFilter::new(), Sink::default());
        emit(&f, &sink, Level::Warn, "t", 10, "failed");
        emit(&f, &sink, Level::Warn, "t", 99, "failed");
        assert_eq!(sink.messages(), vec!["failed", "failed"]);
    }

    #[test]
    fn a_level_change_is_a_different_event_too() {
        let (f, sink) = (DedupFilter::new(), Sink::default());
        emit(&f, &sink, Level::Warn, "t", 10, "hm");
        emit(&f, &sink, Level::Error, "t", 10, "hm");
        assert_eq!(sink.messages().len(), 2);
    }

    #[test]
    fn a_held_run_reports_itself_before_it_ends() {
        // The case this exists for: a message repeating for minutes must not produce *nothing* until
        // it stops. The interim summary doubles as a rate.
        let (f, sink) = (
            DedupFilter::with_limits(Duration::from_millis(0), u64::MAX),
            Sink::default(),
        );
        for _ in 0..3 {
            say(&f, &sink, "spew");
        }
        let m = sink.messages();
        assert_eq!(m[0], "spew");
        assert!(m.len() >= 2, "an interim summary was written: {m:?}");
        assert!(
            m[1].contains("still repeating"),
            "and says the run is not over: {}",
            m[1]
        );
    }

    #[test]
    fn a_count_cap_also_forces_a_summary() {
        let (f, sink) = (DedupFilter::with_limits(Duration::from_secs(3600), 5), Sink::default());
        for _ in 0..7 {
            say(&f, &sink, "flood");
        }
        let m = sink.messages();
        assert!(m.len() >= 2, "{m:?}");
        assert!(m[1].contains("repeated 5 more times"), "{}", m[1]);
        assert!(m[1].contains("still repeating"), "{}", m[1]);
    }

    #[test]
    fn the_summary_keeps_the_level_and_target_of_what_it_counts() {
        // A summary at a different level from the messages it stands for could be filtered out
        // separately from them, which is worse than not having it.
        let (f, sink) = (DedupFilter::new(), Sink::default());
        emit(&f, &sink, Level::Error, "rtt", 10, "boom");
        emit(&f, &sink, Level::Error, "rtt", 10, "boom");
        emit(&f, &sink, Level::Info, "other", 11, "fine");
        let rows = sink.0.lock_recover().clone();
        assert_eq!(rows[1].0, Level::Error, "same level as the run");
        assert_eq!(rows[1].1, "rtt", "same target as the run");
    }

    #[test]
    fn counting_restarts_after_a_flush() {
        let (f, sink) = (DedupFilter::new(), Sink::default());
        for _ in 0..3 {
            say(&f, &sink, "a");
        }
        say(&f, &sink, "b");
        for _ in 0..5 {
            say(&f, &sink, "a");
        }
        say(&f, &sink, "c");
        let m = sink.messages();
        assert!(m[1].contains("repeated 2 more times"), "{}", m[1]);
        assert!(m[4].contains("repeated 4 more times"), "{:?}", m);
    }
}
