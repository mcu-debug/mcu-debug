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

//! ratatui-based Glass Cockpit TUI.
//!
//! Layout (AI section only rendered when an `!!AI-REQUEST:` is active):
//!
//! ```text
//! ┌─────────────────────────────────────────┐
//! │  LIVE OUTPUT  (scrollable)              │  ← [GDB], [RTT#N], [SWO], …
//! │                                         │
//! ├─────────────────────────────────────────┤  (optional)
//! │ ⚑ AI REQUEST  <text>                    │  ← persists until !!AI-REQUEST-CLEAR
//! ├─────────────────────────────────────────┤
//! │ > [user input]                          │  ← always present
//! └─────────────────────────────────────────┘
//! ```
//!
//! Keyboard shortcuts:
//!   ↑/↓              — navigate command history
//!   PgUp/PgDn        — scroll output
//!   End              — jump to bottom (re-enable auto-follow)
//!   Enter            — submit input line (added to history, consecutive duplicates dropped)
//!   Backspace        — delete last character
//!   Ctrl-C           — interrupt target (sends !!SIGINT)
//!   Ctrl-D           — graceful exit (sends "exit" to Node)
//!   Ctrl-X           — emergency TUI exit (kills Node)

use anyhow::Result;
use crossterm::event::{Event, KeyCode, KeyModifiers};
use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
    DefaultTerminal,
};
use std::cell::Cell;
use std::collections::VecDeque;
use std::sync::mpsc;
use std::time::Duration;

use super::transport::{MuxReader, MuxWriter};

const MAX_LINES: usize = 2000;
const POLL_TIMEOUT: Duration = Duration::from_millis(50);

// ── App state ─────────────────────────────────────────────────────────────────

struct App {
    output: VecDeque<String>,
    /// Active AI request text. `None` means the section is hidden.
    ai_request: Option<String>,
    input: String,
    /// Number of lines scrolled up from the bottom (0 = pinned to bottom).
    scroll: u16,
    /// When true, new output lines automatically pull the view to the bottom.
    auto_follow: bool,
    should_quit: bool,
    /// Submitted command history, oldest → newest. Consecutive duplicates are dropped.
    history: Vec<String>,
    /// `Some(i)` while navigating history; `None` when composing a new line.
    history_pos: Option<usize>,
    /// The in-progress draft saved when the user first presses Up.
    history_draft: String,
    /// Height of the output panel in rows, updated every frame by `render_output`.
    /// Used to compute proportional page-scroll amounts in `handle_key`.
    output_height: u16,
}

impl App {
    fn new() -> Self {
        Self {
            output: VecDeque::new(),
            ai_request: None,
            input: String::new(),
            scroll: 0,
            auto_follow: true,
            should_quit: false,
            history: Vec::new(),
            history_pos: None,
            history_draft: String::new(),
            output_height: 20,
        }
    }

    /// Handle a raw line received from the mux socket.
    fn push_line(&mut self, line: String) {
        let trimmed = line.trim_end();

        // Meta-commands emitted by the AI — intercept and don't show in output.
        if let Some(rest) = trimmed.strip_prefix("!!AI-REQUEST: ") {
            self.ai_request = Some(rest.to_owned());
            return;
        }
        if trimmed == "!!AI-REQUEST-CLEAR" {
            self.ai_request = None;
            return;
        }

        // Simulate terminal \r (carriage return) behaviour for progress bars.
        //
        // Two patterns both occur in practice:
        //  (a) single read_line contains multiple updates: "[ 0%]\r[ 50%]\r[100%]\n"
        //      → keep only the last \r-segment for display, append normally
        //  (b) each update ends with \n:  "\r[ 76%] [...]\n"
        //      → strip leading \r, replace the previous output entry (overwrite)
        let starts_with_cr = trimmed.starts_with('\r');
        let display = if trimmed.contains('\r') {
            // Last segment after the final \r is what a real terminal would show.
            trimmed.rsplit('\r').next().unwrap_or(trimmed)
        } else {
            trimmed
        };

        if display.is_empty() {
            return;
        }

        if starts_with_cr && !self.output.is_empty() {
            *self.output.back_mut().unwrap() = format!("{}\n", display);
        } else {
            self.output.push_back(format!("{}\n", display));
        }
        if self.output.len() > MAX_LINES {
            self.output.pop_front();
        }
        if self.auto_follow {
            self.scroll = 0;
        }
    }

    fn scroll_up(&mut self, amount: u16) {
        self.scroll = self.scroll.saturating_add(amount);
        self.auto_follow = false;
    }

    fn scroll_down(&mut self, amount: u16) {
        self.scroll = self.scroll.saturating_sub(amount);
        if self.scroll == 0 {
            self.auto_follow = true;
        }
    }

    fn jump_to_bottom(&mut self) {
        self.scroll = 0;
        self.auto_follow = true;
    }

    fn scroll_page_up(&mut self) {
        let amount = ((self.output_height as f32 * 0.9) as u16).max(1);
        self.scroll_up(amount);
    }

    fn scroll_page_down(&mut self) {
        let amount = ((self.output_height as f32 * 0.9) as u16).max(1);
        self.scroll_down(amount);
    }

    fn history_up(&mut self) {
        if self.history.is_empty() {
            return;
        }
        match self.history_pos {
            None => {
                // Save whatever the user was typing and jump to the most recent entry.
                self.history_draft = std::mem::take(&mut self.input);
                self.history_pos = Some(self.history.len() - 1);
            }
            Some(0) => return, // already at the oldest entry
            Some(i) => {
                self.history_pos = Some(i - 1);
            }
        }
        self.input = self.history[self.history_pos.unwrap()].clone();
    }

    fn history_down(&mut self) {
        match self.history_pos {
            None => return, // already composing a new line
            Some(i) if i + 1 >= self.history.len() => {
                // Past the newest entry → restore the saved draft.
                self.history_pos = None;
                self.input = std::mem::take(&mut self.history_draft);
            }
            Some(i) => {
                self.history_pos = Some(i + 1);
                self.input = self.history[i + 1].clone();
            }
        }
    }

    fn history_push(&mut self, line: &str) {
        // Drop consecutive duplicates (same rule as bash HISTCONTROL=ignoredups).
        if self.history.last().map_or(true, |last| last != line) {
            self.history.push(line.to_owned());
        }
        self.history_pos = None;
        self.history_draft.clear();
    }

    fn handle_key(&mut self, event: crossterm::event::KeyEvent, writer: &mut dyn MuxWriter) {
        match (event.code, event.modifiers) {
            // ── Interrupt: forward to the debug session, TUI stays alive ──────
            // crossterm intercepts Ctrl-C in raw mode; the OS never sees it.
            // We forward `!!SIGINT` over the mux socket so Node can call the
            // DAP `pause` request — same path as `startReadlineRunning`'s
            // SIGINT handler in session-driver.ts.
            (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                self.input.clear();
                let _ = writer.write_line("!!SIGINT");
            }

            // ── Quit the TUI ──────────────────────────────────────────────────
            // Normal exit: type "exit" + Enter → Node terminates → socket EOF
            // → SocketMsg::Eof → should_quit.
            // Ctrl-D: EOF convention — send "exit" to Node for a graceful shutdown.
            // Ctrl-X: emergency escape hatch when the socket is hung (kills Node).
            (KeyCode::Char('d'), KeyModifiers::CONTROL) => {
                self.input.clear();
                // TODO: if the target is running, Node's readline is in "running" mode
                // and discards plain input. A !!QUIT meta-command will be needed once
                // the Node socket reader handles all session states.
                let _ = writer.write_line("exit");
            }
            (KeyCode::Char('x'), KeyModifiers::CONTROL) => {
                self.should_quit = true;
            }

            // ── History navigation ────────────────────────────────────────────
            (KeyCode::Up, KeyModifiers::NONE) => self.history_up(),
            (KeyCode::Down, KeyModifiers::NONE) => self.history_down(),

            // ── Output scroll ─────────────────────────────────────────────────
            (KeyCode::PageUp, _) => self.scroll_page_up(),
            (KeyCode::PageDown, _) => self.scroll_page_down(),
            (KeyCode::End, _) => self.jump_to_bottom(),

            // ── Input editing ─────────────────────────────────────────────────
            (KeyCode::Backspace, _) => {
                self.input.pop();
            }
            (KeyCode::Enter, _) => {
                let line = std::mem::take(&mut self.input);
                if !line.is_empty() {
                    self.history_push(&line);
                    // TODO: prefix with [USER-REQUEST] tag once the wire protocol is confirmed
                    let _ = writer.write_line(&line);
                }
            }
            (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                self.input.push(c);
            }

            _ => {}
        }
    }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

fn render(frame: &mut ratatui::Frame, app: &App, output_height: &Cell<u16>) {
    let has_ai = app.ai_request.is_some();

    // Build vertical layout: output | [ai request] | input
    let constraints = if has_ai {
        vec![
            Constraint::Min(1),     // output — fills remaining space
            Constraint::Length(3),  // AI request
            Constraint::Length(3),  // input bar
        ]
    } else {
        vec![
            Constraint::Min(1),
            Constraint::Length(3),
        ]
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(frame.area());

    render_output(frame, app, chunks[0], output_height);

    if has_ai {
        render_ai_request(frame, app, chunks[1]);
        render_input(frame, app, chunks[2]);
    } else {
        render_input(frame, app, chunks[1]);
    }
}

fn render_output(frame: &mut ratatui::Frame, app: &App, area: ratatui::layout::Rect, output_height: &Cell<u16>) {
    // How many content lines fit (subtract 2 for the block border).
    // Write back so handle_key can compute proportional page-scroll amounts.
    let visible_height = area.height.saturating_sub(2) as usize;
    output_height.set(visible_height as u16);

    let all_lines: Vec<Line> = app
        .output
        .iter()
        .map(|s| Line::from(s.trim_end_matches('\n').to_owned()))
        .collect();

    let total = all_lines.len();
    let scroll = app.scroll as usize;
    let start = total.saturating_sub(visible_height + scroll);
    let visible: Vec<Line> = all_lines.into_iter().skip(start).collect();

    let title = if app.scroll > 0 {
        format!(" Output  ▲ +{} lines ", app.scroll)
    } else {
        " Output ".to_owned()
    };

    let block = Block::default().borders(Borders::ALL).title(title);
    let para = Paragraph::new(Text::from(visible))
        .block(block)
        .wrap(Wrap { trim: false });

    frame.render_widget(para, area);
}

fn render_ai_request(frame: &mut ratatui::Frame, app: &App, area: ratatui::layout::Rect) {
    let text = app.ai_request.as_deref().unwrap_or("");
    let line = Line::from(vec![
        Span::styled(
            "⚑ AI REQUEST  ",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(text),
    ]);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow));
    let para = Paragraph::new(line).block(block);
    frame.render_widget(para, area);
}

fn render_input(frame: &mut ratatui::Frame, app: &App, area: ratatui::layout::Rect) {
    // While navigating history, dim the prompt and show [pos/total] in the title.
    let (prompt_style, title) = match app.history_pos {
        Some(i) => (
            Style::default().fg(Color::Cyan),
            format!(" History [{}/{}] ", i + 1, app.history.len()),
        ),
        None => (Style::default().fg(Color::Green), " Input ".to_owned()),
    };

    let line = Line::from(vec![
        Span::styled("> ", prompt_style),
        Span::raw(&app.input),
        Span::styled("█", prompt_style),
    ]);
    let block = Block::default().borders(Borders::ALL).title(title);
    let para = Paragraph::new(line).block(block);
    frame.render_widget(para, area);
}

// ── Public entry point ────────────────────────────────────────────────────────

enum SocketMsg {
    Line(String),
    Eof,
}

/// Start the ratatui TUI. Blocks until the user quits or the socket closes.
pub fn run_tui(reader: Box<dyn MuxReader>, mut writer: Box<dyn MuxWriter>) -> Result<()> {
    let (tx, rx) = mpsc::channel::<SocketMsg>();

    // Background thread: stream lines from the mux socket into the channel.
    std::thread::spawn(move || {
        let mut reader = reader;
        loop {
            match reader.read_line() {
                Ok(Some(line)) => {
                    if tx.send(SocketMsg::Line(line)).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = tx.send(SocketMsg::Eof);
                    break;
                }
                Err(e) => {
                    let _ = tx.send(SocketMsg::Line(format!("[ERROR] {e}\n")));
                    let _ = tx.send(SocketMsg::Eof);
                    break;
                }
            }
        }
    });

    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, rx, &mut *writer);
    ratatui::restore();

    // After leaving the alternate screen, print the last screenful so the
    // output is visible in the terminal scrollback rather than just vanishing.
    let term_height = crossterm::terminal::size().map(|(_, h)| h as usize).unwrap_or(24);
    if let Ok(output) = &result {
        let skip = output.len().saturating_sub(term_height.saturating_sub(2));
        for line in output.iter().skip(skip) {
            print!("{}", line);
        }
    }
    println!("─── mcu-debug session ended ───");

    result.map(|_| ())
}

fn event_loop(
    terminal: &mut DefaultTerminal,
    rx: mpsc::Receiver<SocketMsg>,
    writer: &mut dyn MuxWriter,
) -> Result<VecDeque<String>> {
    let mut app = App::new();

    loop {
        // Drain all pending socket lines before rendering.
        loop {
            match rx.try_recv() {
                Ok(SocketMsg::Line(line)) => app.push_line(line),
                Ok(SocketMsg::Eof) => {
                    app.should_quit = true;
                    break;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    app.should_quit = true;
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }

        let output_height_cell = Cell::new(app.output_height);
        terminal.draw(|frame| render(frame, &app, &output_height_cell))?;
        app.output_height = output_height_cell.get();

        if app.should_quit {
            break;
        }

        // Poll for keyboard events with a short timeout so socket lines don't stall.
        if crossterm::event::poll(POLL_TIMEOUT)? {
            if let Event::Key(key) = crossterm::event::read()? {
                app.handle_key(key, writer);
            }
        }

        if app.should_quit {
            break;
        }
    }

    Ok(app.output)
}
