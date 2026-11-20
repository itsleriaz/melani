// SPDX-License-Identifier: GPL-3.0-only
//! A small reader for the Markdown the editor writes, for the exporters that need structure:
//! paragraphs, headings, quotes, lists, rules, and inline bold, italic, strikethrough,
//! highlights and footnotes.

#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text(String),
    Bold(Vec<Inline>),
    Italic(Vec<Inline>),
    Strike(Vec<Inline>),
    Highlight(String, Vec<Inline>),
    /// A footnote: its text.
    Note(String),
    Break,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Para(Vec<Inline>),
    Heading(u8, Vec<Inline>),
    Quote(Vec<Block>),
    List { ordered: bool, items: Vec<Vec<Inline>> },
    Rule,
}

const COLORS: [&str; 5] = ["yellow", "green", "blue", "pink", "orange"];

/// `^[note]` at the start of `chars`: the note and the number of chars used.
pub fn read_note(chars: &[char]) -> Option<(String, usize)> {
    if chars.len() < 3 || chars[0] != '^' || chars[1] != '[' {
        return None;
    }
    let (mut note, mut depth, mut i) = (String::new(), 0, 2);
    while i < chars.len() {
        match chars[i] {
            '\\' if i + 1 < chars.len() => {
                i += 1;
                note.push(chars[i]);
            }
            '\n' => return None,
            '[' => {
                depth += 1;
                note.push('[');
            }
            ']' if depth == 0 => return Some((note, i + 1)),
            ']' => {
                depth -= 1;
                note.push(']');
            }
            c => note.push(c),
        }
        i += 1;
    }
    None
}

fn find_close(chars: &[char], from: usize, delim: &[char]) -> Option<usize> {
    let mut i = from;
    while i + delim.len() <= chars.len() {
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if chars[i..i + delim.len()] == *delim && i > from && !chars[i - 1].is_whitespace() {
            // A single * or _ must not be half of a doubled one.
            let single = delim.len() == 1;
            let next_same = single && chars.get(i + 1) == Some(&delim[0]);
            if !next_same {
                return Some(i);
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    None
}

fn flush(text: &mut String, out: &mut Vec<Inline>) {
    if !text.is_empty() {
        out.push(Inline::Text(std::mem::take(text)));
    }
}

pub fn inlines(src: &str) -> Vec<Inline> {
    let chars: Vec<char> = src.chars().collect();
    parse_inline(&chars)
}

fn parse_inline(chars: &[char]) -> Vec<Inline> {
    let mut out = vec![];
    let mut text = String::new();
    let mut i = 0;
    let starts = |i: usize, s: &str| s.chars().enumerate().all(|(k, c)| chars.get(i + k) == Some(&c));
    let opens = |i: usize, n: usize| chars.get(i + n).is_some_and(|c| !c.is_whitespace());
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            if chars[i + 1] == '\n' {
                flush(&mut text, &mut out);
                out.push(Inline::Break);
            } else {
                text.push(chars[i + 1]);
            }
            i += 2;
        } else if c == '^' {
            if let Some((note, used)) = read_note(&chars[i..]) {
                flush(&mut text, &mut out);
                out.push(Inline::Note(note));
                i += used;
            } else {
                text.push(c);
                i += 1;
            }
        } else if starts(i, "==") && (opens(i, 2) || starts(i + 2, "{")) {
            // ==text== or =={color}text==
            let (color, body) = if starts(i + 2, "{") {
                match chars[i + 3..].iter().position(|&c| c == '}') {
                    Some(end) => {
                        let name: String = chars[i + 3..i + 3 + end].iter().collect();
                        if COLORS.contains(&name.as_str()) { (name, i + 3 + end + 1) } else { (String::new(), i + 2) }
                    }
                    None => (String::new(), i + 2),
                }
            } else {
                ("yellow".to_string(), i + 2)
            };
            let color = if color.is_empty() { "yellow".to_string() } else { color };
            if let Some(end) = find_close(chars, body, &['=', '=']) {
                flush(&mut text, &mut out);
                out.push(Inline::Highlight(color, parse_inline(&chars[body..end])));
                i = end + 2;
            } else {
                text.push_str("==");
                i += 2;
            }
        } else if starts(i, "***") && opens(i, 3) {
            match find_close(chars, i + 3, &['*', '*', '*']) {
                Some(end) => {
                    flush(&mut text, &mut out);
                    out.push(Inline::Bold(vec![Inline::Italic(parse_inline(&chars[i + 3..end]))]));
                    i = end + 3;
                }
                None => {
                    text.push('*');
                    i += 1;
                }
            }
        } else if (starts(i, "**") || starts(i, "__")) && opens(i, 2) {
            let d = [c, c];
            match find_close(chars, i + 2, &d) {
                Some(end) => {
                    flush(&mut text, &mut out);
                    out.push(Inline::Bold(parse_inline(&chars[i + 2..end])));
                    i = end + 2;
                }
                None => {
                    text.push(c);
                    i += 1;
                }
            }
        } else if starts(i, "~~") && opens(i, 2) {
            match find_close(chars, i + 2, &['~', '~']) {
                Some(end) => {
                    flush(&mut text, &mut out);
                    out.push(Inline::Strike(parse_inline(&chars[i + 2..end])));
                    i = end + 2;
                }
                None => {
                    text.push('~');
                    i += 1;
                }
            }
        } else if (c == '*' || (c == '_' && (i == 0 || !chars[i - 1].is_alphanumeric()))) && opens(i, 1) {
            match find_close(chars, i + 1, &[c]) {
                Some(end) if c == '*' || chars.get(end + 1).is_none_or(|n| !n.is_alphanumeric()) => {
                    flush(&mut text, &mut out);
                    out.push(Inline::Italic(parse_inline(&chars[i + 1..end])));
                    i = end + 1;
                }
                _ => {
                    text.push(c);
                    i += 1;
                }
            }
        } else {
            text.push(c);
            i += 1;
        }
    }
    flush(&mut text, &mut out);
    out
}

fn is_rule(line: &str) -> bool {
    let t = line.trim();
    let marks: Vec<char> = t.chars().filter(|c| !c.is_whitespace()).collect();
    marks.len() >= 3 && matches!(marks[0], '*' | '-' | '_') && marks.iter().all(|&c| c == marks[0])
}

fn heading(line: &str) -> Option<(u8, &str)> {
    let t = line.trim_start();
    let level = t.chars().take_while(|&c| c == '#').count();
    let rest = &t[level..];
    ((1..=6).contains(&level) && (rest.is_empty() || rest.starts_with(' '))).then(|| (level as u8, rest.trim().trim_end_matches('#').trim()))
}

fn list_item(line: &str) -> Option<(bool, &str)> {
    let t = line.trim_start();
    for m in ["- ", "* ", "+ "] {
        if let Some(r) = t.strip_prefix(m) {
            return Some((false, r));
        }
    }
    let d = t.chars().take_while(|c| c.is_ascii_digit()).count();
    (d > 0 && (t[d..].starts_with(". ") || t[d..].starts_with(") "))).then(|| (true, &t[d + 2..]))
}

pub fn parse(md: &str) -> Vec<Block> {
    let text = md.replace("\r\n", "\n");
    let lines: Vec<&str> = text.lines().collect();
    let mut blocks = vec![];
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
        } else if is_rule(line) {
            blocks.push(Block::Rule);
            i += 1;
        } else if let Some((l, t)) = heading(line) {
            blocks.push(Block::Heading(l, inlines(t)));
            i += 1;
        } else if line.trim_start().starts_with('>') {
            let mut inner = vec![];
            while i < lines.len() && lines[i].trim_start().starts_with('>') {
                inner.push(lines[i].trim_start().trim_start_matches('>').trim_start().to_string());
                i += 1;
            }
            blocks.push(Block::Quote(parse(&inner.join("\n"))));
        } else if let Some((ordered, _)) = list_item(line) {
            let mut items = vec![];
            while i < lines.len() {
                match list_item(lines[i]) {
                    Some((o, t)) if o == ordered => {
                        items.push(inlines(t.trim()));
                        i += 1;
                    }
                    _ => break,
                }
            }
            blocks.push(Block::List { ordered, items });
        } else {
            // A paragraph runs to the next blank line or block start. A line break is a trailing
            // backslash or two spaces; otherwise lines join with a space.
            let mut parts: Vec<String> = vec![];
            while i < lines.len() && !lines[i].trim().is_empty() && !is_rule(lines[i]) && heading(lines[i]).is_none() && !lines[i].trim_start().starts_with('>') && (parts.is_empty() || list_item(lines[i]).is_none()) {
                let l = lines[i];
                let hard = l.ends_with("  ") || l.ends_with('\\');
                let body = l.trim_end().trim_end_matches('\\').trim_start();
                parts.push(if hard { format!("{body}\\\n") } else { format!("{body} ") });
                i += 1;
            }
            let joined = parts.concat();
            blocks.push(Block::Para(inlines(joined.trim_end())));
        }
    }
    blocks
}

/// The text of some inlines with no formatting (footnotes are left out).
pub fn plain(ins: &[Inline]) -> String {
    ins.iter()
        .map(|i| match i {
            Inline::Text(t) => t.clone(),
            Inline::Bold(c) | Inline::Italic(c) | Inline::Strike(c) | Inline::Highlight(_, c) => plain(c),
            Inline::Note(_) => String::new(),
            Inline::Break => " ".into(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use Inline::*;

    fn t(s: &str) -> Inline {
        Text(s.into())
    }

    #[test]
    fn inline_marks_nest_and_close() {
        assert_eq!(inlines("a **b *c* d** e"), vec![t("a "), Bold(vec![t("b "), Italic(vec![t("c")]), t(" d")]), t(" e")]);
        assert_eq!(inlines("~~gone~~ and ==lit== =={blue}cold=="), vec![Strike(vec![t("gone")]), t(" and "), Highlight("yellow".into(), vec![t("lit")]), t(" "), Highlight("blue".into(), vec![t("cold")])]);
        assert_eq!(inlines("***both***"), vec![Bold(vec![Italic(vec![t("both")])])]);
        assert_eq!(inlines("==**x**=="), vec![Highlight("yellow".into(), vec![Bold(vec![t("x")])])]);
    }

    #[test]
    fn stray_marks_and_escapes_stay_text() {
        assert_eq!(inlines("2 * 3 = 6 and a == b"), vec![t("2 * 3 = 6 and a == b")]);
        assert_eq!(inlines("\\*not\\* and snake_case_name"), vec![t("*not* and snake_case_name")]);
        assert_eq!(inlines("open ** never"), vec![t("open ** never")]);
    }

    #[test]
    fn footnotes_are_read_with_brackets_inside() {
        assert_eq!(inlines("Pause^[See [ch 2].] here"), vec![t("Pause"), Note("See [ch 2].".into()), t(" here")]);
        assert_eq!(inlines("x ^ y"), vec![t("x ^ y")]);
    }

    #[test]
    fn blocks() {
        let b = parse("# Title\n\nOne\ntwo line.\n\n> quoted *text*\n\n- a\n- b\n\n1. x\n2. y\n\n* * *\n\nEnd");
        assert_eq!(
            b,
            vec![
                Block::Heading(1, vec![t("Title")]),
                Block::Para(vec![t("One two line.")]),
                Block::Quote(vec![Block::Para(vec![t("quoted "), Italic(vec![t("text")])])]),
                Block::List { ordered: false, items: vec![vec![t("a")], vec![t("b")]] },
                Block::List { ordered: true, items: vec![vec![t("x")], vec![t("y")]] },
                Block::Rule,
                Block::Para(vec![t("End")]),
            ]
        );
    }

    #[test]
    fn hard_breaks_and_plain_text() {
        assert_eq!(parse("a\\\nb"), vec![Block::Para(vec![t("a"), Break, t("b")])]);
        assert_eq!(plain(&inlines("a **b**^[n] c")), "a b c");
    }
}
