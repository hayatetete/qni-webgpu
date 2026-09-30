use eframe::egui;

use crate::app::circuit_library::CircuitEntry;
use crate::app::circuit_picker_state::PickerState;
use crate::app::QniApp;
use crate::colors::Colors;

use super::action::PickerAction;
use super::constants::{ITEM_PAD_X, ITEM_RADIUS, ROW_TEXT_OFFSET};

impl QniApp {
    pub(super) fn show_rename_row(
        &mut self,
        ui: &mut egui::Ui,
        colors: &Colors,
        rect: egui::Rect,
        entry: &CircuitEntry,
        actions: &mut Vec<PickerAction>,
    ) {
        ui.painter().rect(
            rect,
            egui::CornerRadius::same(ITEM_RADIUS),
            colors.surface,
            egui::Stroke::new(1.5_f32, colors.semantic_on), // Flexoki blue-600.
            egui::StrokeKind::Outside,
        );
        let (mut draft, select_all) = match &mut self.picker {
            PickerState::Open {
                renaming: Some(rename),
                ..
            } if rename.entry_id == entry.id => {
                let select_all = rename.select_all_pending;
                rename.select_all_pending = false;
                (rename.draft.clone(), select_all)
            }
            _ => (entry.name.clone(), false),
        };
        let edit_rect = egui::Rect::from_min_max(
            egui::pos2(rect.left() + ROW_TEXT_OFFSET, rect.top()),
            egui::pos2(rect.right() - ITEM_PAD_X, rect.bottom()),
        );
        let text_id = ui.make_persistent_id(("circuit-picker-rename", &entry.id));
        let mut edit_ui = ui.new_child(
            egui::UiBuilder::new()
                .id_salt(("rename-child", &entry.id))
                .max_rect(edit_rect)
                .layout(egui::Layout::left_to_right(egui::Align::Center)),
        );
        edit_ui.set_min_size(edit_rect.size());
        edit_ui.visuals_mut().selection.stroke = egui::Stroke::new(0.0_f32, colors.text_strong); // selected glyphs use Flexoki tx (near-black).
        let output = egui::TextEdit::singleline(&mut draft)
            .id(text_id)
            .font(egui::FontId::new(14.0, egui::FontFamily::Proportional)) // text-sm = 14px.
            .text_color(colors.text_strong) // Flexoki tx.
            .frame(false)
            .margin(egui::Margin::symmetric(0, 2)) // px-0, py-0.5 = 2px.
            .desired_width(edit_rect.width())
            .show(&mut edit_ui);
        publish_picker_rename_geometry_json(
            rect,
            output.galley_pos.x,
            edit_ui.visuals().selection.stroke.color,
        );
        if select_all {
            output.response.request_focus();
            let mut state = output.state;
            state
                .cursor
                .set_char_range(Some(egui::text::CCursorRange::two(
                    egui::text::CCursor::default(),
                    egui::text::CCursor::new(draft.chars().count()),
                )));
            state.store(ui.ctx(), output.response.id);
        }
        let (enter, escape) = ui.input(|input| {
            input
                .events
                .iter()
                .fold((false, false), |(enter, escape), event| {
                    if let egui::Event::Key {
                        key, pressed: true, ..
                    } = event
                    {
                        (
                            enter || *key == egui::Key::Enter,
                            escape || *key == egui::Key::Escape,
                        )
                    } else {
                        (enter, escape)
                    }
                })
        });
        if escape {
            actions.push(PickerAction::CancelRename);
        } else if enter || output.response.lost_focus() {
            actions.push(PickerAction::CommitRename {
                entry_id: entry.id.clone(),
                draft,
            });
        } else {
            actions.push(PickerAction::UpdateRenameDraft {
                entry_id: entry.id.clone(),
                draft,
            });
        }
    }
}

#[cfg(all(target_arch = "wasm32", debug_assertions))]
fn publish_picker_rename_geometry_json(
    row_rect: egui::Rect,
    edit_text_left: f32,
    selection_text_color: egui::Color32,
) {
    let row_text_left = row_rect.left() + ROW_TEXT_OFFSET;
    let json = format!(
        "{{\"row_text_left\":{row_text_left:.3},\"edit_text_left\":{edit_text_left:.3},\"selection_text_rgba\":[{},{},{},{}]}}",
        selection_text_color.r(),
        selection_text_color.g(),
        selection_text_color.b(),
        selection_text_color.a(),
    );
    crate::test_hooks::set_window_value(
        crate::test_hooks::QNI_CIRCUIT_PICKER_RENAME_GEOMETRY_JSON,
        &wasm_bindgen::JsValue::from_str(&json),
    );
}

#[cfg(any(not(target_arch = "wasm32"), not(debug_assertions)))]
fn publish_picker_rename_geometry_json(
    _row_rect: egui::Rect,
    _edit_text_left: f32,
    _selection_text_color: egui::Color32,
) {
}
