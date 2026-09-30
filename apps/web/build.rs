use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

const ICONS: [(&str, &str); 18] = [
    ("H", "h.png"),
    ("X", "x.png"),
    ("Y", "y.png"),
    ("Z", "z.png"),
    ("PLUS", "plus.png"),
    ("SQRTX", "sqrtx.png"),
    ("S", "s.png"),
    ("SDAGGER", "sdagger.png"),
    ("T", "t.png"),
    ("TDAGGER", "tdagger.png"),
    ("P", "p.png"),
    ("RX", "rx.png"),
    ("RY", "ry.png"),
    ("RZ", "rz.png"),
    ("QFT", "qft.png"),
    ("QFTDAGGER", "qftdagger.png"),
    ("DIGIT0", "digit0.png"),
    ("DIGIT1", "digit1.png"),
];
const RASTER_SIZE: u32 = 256;
const SDF_PX_RANGE: f32 = 32.0;
const INF_DISTANCE: f32 = 1.0e20;
const EDGE_ALPHA: u8 = 128;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("out dir"));
    let out_path = out_dir.join("gate_icon_alpha.rs");
    let mut generated = String::new();
    generated.push_str(&format!(
        "pub(super) const RASTER_SIZE: usize = {RASTER_SIZE};\n"
    ));
    generated.push_str(&format!(
        "pub(super) const SDF_PX_RANGE: f32 = {SDF_PX_RANGE:.1};\n"
    ));

    for (symbol, file_name) in ICONS {
        let path = manifest_dir.join("assets/icons").join(file_name);
        println!("cargo:rerun-if-changed={}", path.display());
        let alpha = read_png_alpha(&path);
        let alpha_rle = encode_rle(&alpha);
        generated.push_str(&format!(
            "pub(super) const {symbol}_ALPHA_RLE: &[(u16, u8)] = &["
        ));
        for (run, value) in alpha_rle {
            generated.push_str(&format!("({run},{value}),"));
        }
        generated.push_str("];\n");

        let sdf = build_sdf(&alpha, RASTER_SIZE as usize, SDF_PX_RANGE);
        let sdf_rle = encode_rle(&sdf);
        generated.push_str(&format!(
            "pub(super) const {symbol}_SDF_RLE: &[(u16, u8)] = &["
        ));
        for (run, value) in &sdf_rle {
            generated.push_str(&format!("({run},{value}),"));
        }
        generated.push_str("];\n");
    }

    fs::write(out_path, generated).expect("write generated icon alpha data");
}

fn read_png_alpha(path: &Path) -> Vec<u8> {
    let file = fs::File::open(path).unwrap_or_else(|error| {
        panic!("failed to open {}: {error}", path.display());
    });
    let decoder = png::Decoder::new(BufReader::new(file));
    let mut reader = decoder.read_info().unwrap_or_else(|error| {
        panic!("failed to read {}: {error}", path.display());
    });
    let mut buffer = vec![0; reader.output_buffer_size().expect("png output size")];
    let info = reader.next_frame(&mut buffer).unwrap_or_else(|error| {
        panic!("failed to decode {}: {error}", path.display());
    });
    assert_eq!(
        (info.width, info.height, info.color_type, info.bit_depth),
        (
            RASTER_SIZE,
            RASTER_SIZE,
            png::ColorType::Rgba,
            png::BitDepth::Eight
        ),
        "{} must be a 256×256 8-bit RGBA PNG",
        path.display()
    );
    let alpha = buffer[..info.buffer_size()]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|rgba| rgba[3])
        .collect::<Vec<_>>();
    assert!(
        alpha.iter().any(|value| *value > 0),
        "{} must contain visible glyph pixels",
        path.display()
    );
    alpha
}

fn encode_rle(alpha: &[u8]) -> Vec<(u16, u8)> {
    let mut encoded = Vec::new();
    let mut iter = alpha.iter().copied();
    let Some(mut value) = iter.next() else {
        return encoded;
    };
    let mut run: u16 = 1;
    for next in iter {
        if next == value && run < u16::MAX {
            run += 1;
        } else {
            encoded.push((run, value));
            value = next;
            run = 1;
        }
    }
    encoded.push((run, value));
    encoded
}

fn build_sdf(alpha: &[u8], size: usize, px_range: f32) -> Vec<u8> {
    let inside = alpha
        .iter()
        .map(|value| *value >= EDGE_ALPHA)
        .collect::<Vec<_>>();
    assert!(
        inside.iter().any(|value| *value),
        "glyph must have interior pixels"
    );
    assert!(
        inside.iter().any(|value| !*value),
        "glyph must have exterior pixels"
    );

    let inside_distance = distance_to_feature(&inside, size, true);
    let outside_distance = distance_to_feature(&inside, size, false);
    inside
        .iter()
        .enumerate()
        .map(|(index, is_inside)| {
            let signed = if *is_inside {
                outside_distance[index].sqrt() - 0.5
            } else {
                0.5 - inside_distance[index].sqrt()
            };
            let normalized = (0.5 + signed / px_range).clamp(0.0, 1.0);
            (normalized * 255.0).round() as u8
        })
        .collect()
}

fn distance_to_feature(mask: &[bool], size: usize, feature_value: bool) -> Vec<f32> {
    let mut grid = vec![0.0; size * size];
    for (index, value) in mask.iter().enumerate() {
        grid[index] = if *value == feature_value {
            0.0
        } else {
            INF_DISTANCE
        };
    }

    let mut column = vec![0.0; size];
    let mut distances = vec![0.0; size];
    for x in 0..size {
        for y in 0..size {
            column[y] = grid[y * size + x];
        }
        edt_1d(&column, &mut distances);
        for y in 0..size {
            grid[y * size + x] = distances[y];
        }
    }

    let mut row = vec![0.0; size];
    for y in 0..size {
        let row_start = y * size;
        row.copy_from_slice(&grid[row_start..row_start + size]);
        edt_1d(&row, &mut distances);
        grid[row_start..row_start + size].copy_from_slice(&distances);
    }
    grid
}

fn edt_1d(input: &[f32], output: &mut [f32]) {
    let n = input.len();
    let mut v = vec![0usize; n];
    let mut z = vec![0.0f32; n + 1];
    let mut k = 0usize;
    v[0] = 0;
    z[0] = f32::NEG_INFINITY;
    z[1] = f32::INFINITY;

    for q in 1..n {
        let mut s = intersection(input, q, v[k]);
        while s <= z[k] {
            k -= 1;
            s = intersection(input, q, v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f32::INFINITY;
    }

    k = 0;
    for (q, value) in output.iter_mut().enumerate() {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let dx = q as f32 - v[k] as f32;
        *value = dx * dx + input[v[k]];
    }
}

fn intersection(input: &[f32], q: usize, vk: usize) -> f32 {
    ((input[q] + (q * q) as f32) - (input[vk] + (vk * vk) as f32))
        / (2.0 * q as f32 - 2.0 * vk as f32)
}
