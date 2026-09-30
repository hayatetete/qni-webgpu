use std::env;
use std::fs::File;
use std::io::{self, Write};

use ratatui::layout::Rect;
use ratatui::style::Color;

use qni_webgpu_tui::{render_to_buffer, AppState};

fn ansi16_rgb(index: u8) -> (u8, u8, u8) {
    const COLORS: [(u8, u8, u8); 16] = [
        (0, 0, 0),
        (205, 0, 0),
        (0, 205, 0),
        (205, 205, 0),
        (0, 0, 238),
        (205, 0, 205),
        (0, 205, 205),
        (229, 229, 229),
        (127, 127, 127),
        (255, 0, 0),
        (0, 255, 0),
        (255, 255, 0),
        (92, 92, 255),
        (255, 0, 255),
        (0, 255, 255),
        (255, 255, 255),
    ];
    COLORS[index as usize]
}

fn indexed_rgb(index: u8) -> (u8, u8, u8) {
    if index < 16 {
        return ansi16_rgb(index);
    }
    if index < 232 {
        let idx = index - 16;
        let r = idx / 36;
        let g = (idx / 6) % 6;
        let b = idx % 6;
        let conv = |v: u8| -> u8 {
            match v {
                0 => 0,
                1 => 95,
                2 => 135,
                3 => 175,
                4 => 215,
                _ => 255,
            }
        };
        return (conv(r), conv(g), conv(b));
    }
    let gray = 8 + (index - 232) * 10;
    (gray, gray, gray)
}

fn color_to_rgb(color: Color) -> Option<(u8, u8, u8)> {
    match color {
        Color::Reset => None,
        Color::Black => Some((0, 0, 0)),
        Color::Red => Some((205, 0, 0)),
        Color::Green => Some((0, 205, 0)),
        Color::Yellow => Some((205, 205, 0)),
        Color::Blue => Some((0, 0, 238)),
        Color::Magenta => Some((205, 0, 205)),
        Color::Cyan => Some((0, 205, 205)),
        Color::Gray => Some((229, 229, 229)),
        Color::DarkGray => Some((127, 127, 127)),
        Color::LightRed => Some((255, 0, 0)),
        Color::LightGreen => Some((0, 255, 0)),
        Color::LightYellow => Some((255, 255, 0)),
        Color::LightBlue => Some((92, 92, 255)),
        Color::LightMagenta => Some((255, 0, 255)),
        Color::LightCyan => Some((0, 255, 255)),
        Color::White => Some((255, 255, 255)),
        Color::Indexed(index) => Some(indexed_rgb(index)),
        Color::Rgb(r, g, b) => Some((r, g, b)),
    }
}

fn encode_color(color: Color) -> String {
    match color_to_rgb(color) {
        Some((r, g, b)) => format!("#{:02X}{:02X}{:02X}", r, g, b),
        None => "-".to_string(),
    }
}

fn main() -> io::Result<()> {
    let mut width: u16 = 80;
    let mut height: u16 = 30;
    let mut out_path: Option<String> = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--width" => {
                if let Some(value) = args.next() {
                    width = value.parse().unwrap_or(width);
                }
            }
            "--height" => {
                if let Some(value) = args.next() {
                    height = value.parse().unwrap_or(height);
                }
            }
            "--out" => {
                out_path = args.next();
            }
            _ => {}
        }
    }

    let area = Rect::new(0, 0, width, height);
    let mut state = AppState::new();
    let buffer = render_to_buffer(&mut state, area, None);

    let mut output = String::new();
    output.push_str(&format!("SIZE\t{}\t{}\n", width, height));
    for y in 0..height {
        for x in 0..width {
            let cell = &buffer[(x, y)];
            let mut symbol = cell.symbol().to_string();
            if symbol.is_empty() {
                symbol = " ".to_string();
            }
            if symbol.contains('\t') {
                symbol = symbol.replace('\t', " ");
            }
            let fg = encode_color(cell.fg);
            let bg = encode_color(cell.bg);
            output.push_str(&format!("CELL\t{}\t{}\t{}\t{}\t{}\n", x, y, symbol, fg, bg));
        }
    }

    match out_path {
        Some(path) => {
            let mut file = File::create(path)?;
            file.write_all(output.as_bytes())?;
        }
        None => {
            let mut stdout = io::stdout();
            stdout.write_all(output.as_bytes())?;
        }
    }
    Ok(())
}
