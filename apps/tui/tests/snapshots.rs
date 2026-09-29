use ratatui::backend::TestBackend;
use ratatui::Terminal;

use qni_webgpu_tui::{render_to_buffer, AppState};

#[test]
fn snapshot_two_qubit_state_circles() {
    let backend = TestBackend::new(80, 30);
    let mut terminal = Terminal::new(backend).expect("terminal");
    let mut state = AppState::new();

    terminal
        .draw(|frame| {
            let area = frame.area();
            let buffer = render_to_buffer(&mut state, area, None);
            let frame_buffer = frame.buffer_mut();
            for y in 0..area.height {
                for x in 0..area.width {
                    let pos = (area.x + x, area.y + y);
                    frame_buffer[pos] = buffer[pos].clone();
                }
            }
        })
        .expect("draw");

    let snapshot = format!("{}", terminal.backend());
    insta::assert_snapshot!(snapshot);
}
