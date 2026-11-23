/// Pure-Rust terminal state emulator and replay serializer built on `vt100`.
/// Preserves scrollback lines, active screen formatting, cursor, alternate screen,
/// bracketed paste, and exact mouse tracking + mouse encoding modes (1006 / 1016).
pub struct TerminalScreen {
    parser: vt100::Parser,
    mouse_encoding: u16,
    esc_state: EscState,
    csi_params: String,
    csi_private: bool,
    pending_responses: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EscState {
    Normal,
    Esc,
    Csi,
    Osc,
    OscEsc,
}

impl TerminalScreen {
    pub fn new(rows: u16, cols: u16, scrollback: usize) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, scrollback),
            mouse_encoding: 0,
            esc_state: EscState::Normal,
            csi_params: String::new(),
            csi_private: false,
            pending_responses: Vec::new(),
        }
    }

    pub fn size(&self) -> (u16, u16) {
        self.parser.screen().size()
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.set_size(rows, cols);
    }

    /// Feed PTY output bytes into the screen state and track mouse encoding & DSR queries.
    /// Returns any terminal status replies (e.g., cursor position report for `\x1b[6n`)
    /// that the daemon should send back ONLY when no UI peer is currently attached.
    pub fn process(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.parser.process(bytes);
        self.observe_controls(bytes);
        std::mem::take(&mut self.pending_responses)
    }

    fn observe_controls(&mut self, bytes: &[u8]) {
        for &b in bytes {
            match self.esc_state {
                EscState::Normal => {
                    if b == 0x1b {
                        self.esc_state = EscState::Esc;
                    }
                }
                EscState::Esc => match b {
                    b'[' => {
                        self.esc_state = EscState::Csi;
                        self.csi_params.clear();
                        self.csi_private = false;
                    }
                    b']' => {
                        self.esc_state = EscState::Osc;
                    }
                    b'c' => {
                        // RIS full terminal reset clears mouse encoding.
                        self.mouse_encoding = 0;
                        self.esc_state = EscState::Normal;
                    }
                    _ => {
                        self.esc_state = EscState::Normal;
                    }
                },
                EscState::Osc => {
                    if b == 0x07 {
                        self.esc_state = EscState::Normal;
                    } else if b == 0x1b {
                        self.esc_state = EscState::OscEsc;
                    }
                }
                EscState::OscEsc => {
                    if b == b'\\' {
                        self.esc_state = EscState::Normal;
                    } else {
                        self.esc_state = EscState::Osc;
                    }
                }
                EscState::Csi => {
                    if b == b'?' && self.csi_params.is_empty() && !self.csi_private {
                        self.csi_private = true;
                    } else if (0x30..=0x3f).contains(&b) {
                        if self.csi_params.len() < 64 {
                            self.csi_params.push(b as char);
                        }
                    } else if (0x20..=0x2f).contains(&b) {
                        // Intermediate bytes
                    } else if (0x40..=0x7e).contains(&b) {
                        self.handle_csi(b);
                        self.esc_state = EscState::Normal;
                    } else {
                        self.esc_state = EscState::Normal;
                    }
                }
            }
        }
    }

    fn handle_csi(&mut self, final_byte: u8) {
        if self.csi_private && (final_byte == b'h' || final_byte == b'l') {
            for part in self.csi_params.split(';') {
                if let Ok(mode) = part.parse::<u16>() {
                    if mode == 1006 || mode == 1016 {
                        self.mouse_encoding = if final_byte == b'h' { mode } else { 0 };
                    }
                }
            }
        } else if !self.csi_private && final_byte == b'n' && self.csi_params == "6" {
            // DSR: Report cursor position so detached TUIs do not stall waiting for CPR.
            let (row, col) = self.parser.screen().cursor_position();
            let reply = format!("\x1b[{};{}R", row + 1, col + 1);
            self.pending_responses.push(reply.into_bytes());
        } else if !self.csi_private && final_byte == b'c' && (self.csi_params.is_empty() || self.csi_params == "0") {
            // Primary DA
            self.pending_responses.push(b"\x1b[?62;22c".to_vec());
        }
    }

    fn mouse_encoding_suffix(&self) -> String {
        let mut out = String::from("\x1b[?1006l\x1b[?1016l");
        if self.mouse_encoding == 1006 || self.mouse_encoding == 1016 {
            out.push_str(&format!("\x1b[?{}h", self.mouse_encoding));
        }
        out
    }

    /// Serialize scrollback + active screen + terminal modes into a UTF-8 ANSI replay string
    /// ready for `xterm.js` after `term.reset(); term.resize(cols, rows)`.
    pub fn serialize(&mut self) -> String {
        let (rows, cols) = self.parser.screen().size();
        let alt = self.parser.screen().alternate_screen();

        let mut out: Vec<u8> = Vec::with_capacity(8192);

        if alt {
            // Alternate screen: vt100::Screen::state_formatted() enters ?1049h and restores
            // the full alt screen, attributes, cursor, and input/mouse modes.
            out.extend_from_slice(&self.parser.screen().state_formatted());
            out.extend_from_slice(self.mouse_encoding_suffix().as_bytes());
            return String::from_utf8_lossy(&out).into_owned();
        }

        // Normal screen: replay scrollback lines first so xterm.js builds real scrollback.
        self.parser.set_scrollback(usize::MAX);
        let max_scrollback = self.parser.screen().scrollback();

        if max_scrollback > 0 {
            let rows_usize = usize::from(rows).max(1);
            let mut remaining = max_scrollback;
            while remaining > 0 {
                self.parser.set_scrollback(remaining);
                let take = remaining.min(rows_usize);
                for line in self.parser.screen().rows_formatted(0, cols).take(take) {
                    out.extend_from_slice(&line);
                    out.extend_from_slice(b"\x1b[m\r\n");
                }
                remaining -= take;
            }
            self.parser.set_scrollback(0);

            // Emit visible viewport rows right after scrollback so those `max_scrollback`
            // lines push cleanly into xterm's scrollback buffer even when `max_scrollback < rows`.
            let visible: Vec<Vec<u8>> = self.parser.screen().rows_formatted(0, cols).collect();
            for (idx, line) in visible.iter().enumerate() {
                out.extend_from_slice(line);
                out.extend_from_slice(b"\x1b[m");
                if idx + 1 < visible.len() {
                    out.extend_from_slice(b"\r\n");
                }
            }

            // Now restore exact cursor position, active pen attributes, visibility, and modes.
            let screen = self.parser.screen();
            out.extend_from_slice(&screen.cursor_state_formatted());
            out.extend_from_slice(&screen.attributes_formatted());
            out.extend_from_slice(&screen.input_mode_formatted());
            out.extend_from_slice(self.mouse_encoding_suffix().as_bytes());
        } else {
            self.parser.set_scrollback(0);
            out.extend_from_slice(&self.parser.screen().state_formatted());
            out.extend_from_slice(self.mouse_encoding_suffix().as_bytes());
        }

        String::from_utf8_lossy(&out).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_scrollback_visible_lines_and_cursor() {
        let mut screen = TerminalScreen::new(6, 40, 200);
        for i in 1..=10 {
            let line = format!("line-{i:02}\r\n");
            screen.process(line.as_bytes());
        }
        screen.process(b"prompt$ ");

        let replay = screen.serialize();
        let mut target = vt100::Parser::new(6, 40, 200);
        target.process(replay.as_bytes());

        // Check visible screen matches
        assert_eq!(target.screen().contents(), screen.parser.screen().contents());
        assert_eq!(
            target.screen().cursor_position(),
            screen.parser.screen().cursor_position()
        );

        // Check scrollback lines exist and match oldest line
        target.set_scrollback(usize::MAX);
        assert!(target.screen().scrollback() >= 5);
        assert!(target.screen().contents().contains("line-01"));
    }

    #[test]
    fn preserves_small_scrollback_less_than_viewport_rows() {
        let mut screen = TerminalScreen::new(10, 40, 200);
        for i in 1..=12 {
            let line = format!("row-{i:02}\r\n");
            screen.process(line.as_bytes());
        }
        let replay = screen.serialize();
        let mut target = vt100::Parser::new(10, 40, 200);
        target.process(replay.as_bytes());

        assert_eq!(target.screen().contents(), screen.parser.screen().contents());
        target.set_scrollback(usize::MAX);
        assert_eq!(target.screen().scrollback(), 3);
        assert!(target.screen().contents().contains("row-01"));
    }

    #[test]
    fn preserves_mouse_encoding_1006_and_1016_across_split_writes() {
        let mut screen = TerminalScreen::new(10, 40, 200);
        screen.process(b"\x1b[?1049h\x1b[?1000h\x1b[?10");
        screen.process(b"06hhello alt");
        let replay = screen.serialize();
        assert!(replay.contains("\x1b[?1006h"));
        assert!(replay.contains("hello alt"));

        // Switch to 1016 pixel mode
        screen.process(b"\x1b[?1016h");
        let replay2 = screen.serialize();
        assert!(replay2.contains("\x1b[?1016h"));

        // Reset clears encoding
        screen.process(b"\x1bc");
        let replay3 = screen.serialize();
        assert!(!replay3.contains("\x1b[?1006h"));
        assert!(!replay3.contains("\x1b[?1016h"));
    }

    #[test]
    fn answers_dsr_cursor_query_when_detached() {
        let mut screen = TerminalScreen::new(10, 40, 200);
        screen.process(b"abc\x1b[6n");
        let replies = screen.process(b"\x1b[6n");
        assert_eq!(replies, vec![b"\x1b[1;4R".to_vec()]);
    }
}
