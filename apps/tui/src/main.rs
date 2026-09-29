use std::io;

use crossterm::event::{self, Event, KeyCode, KeyModifiers, MouseButton, MouseEventKind};
use crossterm::execute;
use crossterm::terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use qni_webgpu_tui::{
    confirm_hovered_column, handle_mouse_down, handle_mouse_move, handle_mouse_up,
    handle_phase_edit_key, render_to_buffer_with_drag, update_hovered_slot, AppState, DragVisual,
    QuitChoice,
};

fn draw_once(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    state: &mut AppState,
    debug_line: Option<&str>,
    drag_visual: Option<DragVisual>,
) -> io::Result<()> {
    terminal.draw(|frame| {
        let area = frame.area();
        let buffer = render_to_buffer_with_drag(state, area, debug_line, drag_visual);
        let frame_buffer = frame.buffer_mut();
        for y in 0..area.height {
            for x in 0..area.width {
                let pos = (area.x + x, area.y + y);
                frame_buffer[pos] = buffer[pos].clone();
            }
        }
    })?;
    Ok(())
}

fn run() -> io::Result<()> {
    let mut app_state = AppState::new();
    let debug_line: Option<String> = None;

    terminal::enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(
        stdout,
        terminal::EnterAlternateScreen,
        event::EnableMouseCapture
    )?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;
    loop {
        let drag_visual = app_state.dragging.and_then(|drag| {
            app_state.drag_pos.map(|(x, y)| DragVisual {
                gate: drag.gate,
                x,
                y,
            })
        });
        draw_once(
            &mut terminal,
            &mut app_state,
            debug_line.as_deref(),
            drag_visual,
        )?;
        if event::poll(std::time::Duration::from_millis(250))? {
            match event::read()? {
                Event::Key(key) => {
                    if app_state.quit_confirm {
                        match key.code {
                            KeyCode::Left | KeyCode::Char('h') => {
                                app_state.quit_choice = QuitChoice::Yes;
                            }
                            KeyCode::Right | KeyCode::Char('l') => {
                                app_state.quit_choice = QuitChoice::No;
                            }
                            KeyCode::Char('y') | KeyCode::Char('Y') => {
                                app_state.quit_choice = QuitChoice::Yes;
                            }
                            KeyCode::Char('n') | KeyCode::Char('N') => {
                                app_state.quit_choice = QuitChoice::No;
                            }
                            KeyCode::Enter => {
                                if app_state.quit_choice == QuitChoice::Yes {
                                    break;
                                }
                                app_state.quit_confirm = false;
                            }
                            KeyCode::Esc => {
                                app_state.quit_confirm = false;
                            }
                            _ => {}
                        }
                        continue;
                    }
                    if app_state.phase_edit.is_some() {
                        handle_phase_edit_key(&mut app_state, key);
                        continue;
                    }
                    if key.code == KeyCode::Char('c')
                        && key.modifiers.contains(KeyModifiers::CONTROL)
                    {
                        break;
                    }
                    if key.code == KeyCode::Char('q') {
                        app_state.quit_confirm = true;
                        app_state.quit_choice = QuitChoice::No;
                    }
                }
                Event::Mouse(mouse) => {
                    if app_state.quit_confirm {
                        continue;
                    }
                    let area = terminal.size()?.into();
                    match mouse.kind {
                        MouseEventKind::Down(MouseButton::Left) => {
                            handle_mouse_down(&mut app_state, mouse.column, mouse.row, area);
                            update_hovered_slot(&mut app_state, mouse.column, mouse.row, area);
                            confirm_hovered_column(&mut app_state);
                        }
                        MouseEventKind::Drag(MouseButton::Left) => {
                            if app_state.dragging.is_none() {
                                handle_mouse_down(&mut app_state, mouse.column, mouse.row, area);
                            }
                            handle_mouse_move(&mut app_state, mouse.column, mouse.row);
                            update_hovered_slot(&mut app_state, mouse.column, mouse.row, area);
                        }
                        MouseEventKind::Moved => {
                            handle_mouse_move(&mut app_state, mouse.column, mouse.row);
                            update_hovered_slot(&mut app_state, mouse.column, mouse.row, area);
                        }
                        MouseEventKind::Up(MouseButton::Left) => {
                            handle_mouse_up(&mut app_state, mouse.column, mouse.row, area);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn main() -> io::Result<()> {
    let result = run();
    terminal::disable_raw_mode()?;
    let _ = execute!(
        io::stdout(),
        event::DisableMouseCapture,
        terminal::LeaveAlternateScreen
    );
    result
}
