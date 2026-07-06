//! A minimal, dependency-free JSON parser (RFC 8259 subset, enough for seals).
//!
//! We can't pull in serde with a zero-crate rule, so this is a small
//! recursive-descent parser. It fully decodes string escapes (including
//! `\uXXXX` surrogate pairs), which matters: the outer packet embeds the
//! signed seal as an escaped JSON string in `attestation`.

use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    // Insertion order isn't needed by callers here; a map is enough.
    Object(BTreeMap<String, Value>),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Value::Object(_))
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(m) => m.get(key),
            _ => None,
        }
    }
}

pub fn parse(input: &str) -> Result<Value, String> {
    let bytes = input.as_bytes();
    let mut p = Parser { bytes, pos: 0 };
    p.skip_ws();
    let v = p.parse_value()?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        return Err(format!("trailing data at byte {}", p.pos));
    }
    Ok(v)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self) -> Result<Value, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => Ok(Value::String(self.parse_string()?)),
            Some(b't') | Some(b'f') => self.parse_bool(),
            Some(b'n') => self.parse_null(),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.parse_number(),
            Some(c) => Err(format!("unexpected byte 0x{:02x} at {}", c, self.pos)),
            None => Err("unexpected end of input".to_string()),
        }
    }

    fn expect(&mut self, c: u8) -> Result<(), String> {
        if self.peek() == Some(c) {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at byte {}", c as char, self.pos))
        }
    }

    fn parse_object(&mut self) -> Result<Value, String> {
        self.expect(b'{')?;
        let mut map = BTreeMap::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(map));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(format!("expected object key at byte {}", self.pos));
            }
            let key = self.parse_string()?;
            self.skip_ws();
            self.expect(b':')?;
            let val = self.parse_value()?;
            map.insert(key, val);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(format!("expected ',' or '}}' at byte {}", self.pos)),
            }
        }
        Ok(Value::Object(map))
    }

    fn parse_array(&mut self) -> Result<Value, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            let val = self.parse_value()?;
            items.push(val);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(format!("expected ',' or ']' at byte {}", self.pos)),
            }
        }
        Ok(Value::Array(items))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or("unterminated string")?;
            self.pos += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let esc = self.peek().ok_or("unterminated escape")?;
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let cp = self.parse_hex4()?;
                            if (0xD800..=0xDBFF).contains(&cp) {
                                // high surrogate — expect a following low surrogate
                                if self.peek() != Some(b'\\') {
                                    return Err("expected low surrogate".to_string());
                                }
                                self.pos += 1;
                                if self.peek() != Some(b'u') {
                                    return Err("expected low surrogate".to_string());
                                }
                                self.pos += 1;
                                let lo = self.parse_hex4()?;
                                if !(0xDC00..=0xDFFF).contains(&lo) {
                                    return Err("invalid low surrogate".to_string());
                                }
                                let combined =
                                    0x10000 + (((cp - 0xD800) as u32) << 10) + (lo - 0xDC00) as u32;
                                out.push(
                                    char::from_u32(combined).ok_or("invalid surrogate pair")?,
                                );
                            } else {
                                out.push(char::from_u32(cp as u32).ok_or("invalid \\u escape")?);
                            }
                        }
                        other => return Err(format!("invalid escape \\{}", other as char)),
                    }
                }
                // Raw UTF-8 continuation/lead bytes: copy verbatim into the string.
                _ => {
                    // Determine the length of this UTF-8 sequence from the lead byte.
                    let len = if c < 0x80 {
                        1
                    } else if c >> 5 == 0b110 {
                        2
                    } else if c >> 4 == 0b1110 {
                        3
                    } else if c >> 3 == 0b11110 {
                        4
                    } else {
                        return Err("invalid UTF-8 lead byte".to_string());
                    };
                    let start = self.pos - 1;
                    let end = start + len;
                    if end > self.bytes.len() {
                        return Err("truncated UTF-8 sequence".to_string());
                    }
                    let s = std::str::from_utf8(&self.bytes[start..end])
                        .map_err(|_| "invalid UTF-8".to_string())?;
                    out.push_str(s);
                    self.pos = end;
                }
            }
        }
        Ok(out)
    }

    fn parse_hex4(&mut self) -> Result<u16, String> {
        if self.pos + 4 > self.bytes.len() {
            return Err("truncated \\u escape".to_string());
        }
        let mut v: u16 = 0;
        for _ in 0..4 {
            let d = self.bytes[self.pos];
            let nibble = match d {
                b'0'..=b'9' => d - b'0',
                b'a'..=b'f' => d - b'a' + 10,
                b'A'..=b'F' => d - b'A' + 10,
                _ => return Err("invalid hex digit in \\u escape".to_string()),
            };
            v = (v << 4) | nibble as u16;
            self.pos += 1;
        }
        Ok(v)
    }

    fn parse_bool(&mut self) -> Result<Value, String> {
        if self.bytes[self.pos..].starts_with(b"true") {
            self.pos += 4;
            Ok(Value::Bool(true))
        } else if self.bytes[self.pos..].starts_with(b"false") {
            self.pos += 5;
            Ok(Value::Bool(false))
        } else {
            Err(format!("invalid literal at byte {}", self.pos))
        }
    }

    fn parse_null(&mut self) -> Result<Value, String> {
        if self.bytes[self.pos..].starts_with(b"null") {
            self.pos += 4;
            Ok(Value::Null)
        } else {
            Err(format!("invalid literal at byte {}", self.pos))
        }
    }

    fn parse_number(&mut self) -> Result<Value, String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        while let Some(c) = self.peek() {
            if c.is_ascii_digit()
                || c == b'.'
                || c == b'e'
                || c == b'E'
                || c == b'+'
                || c == b'-'
            {
                self.pos += 1;
            } else {
                break;
            }
        }
        let s = std::str::from_utf8(&self.bytes[start..self.pos]).unwrap();
        s.parse::<f64>()
            .map(Value::Number)
            .map_err(|_| format!("invalid number '{}'", s))
    }
}
