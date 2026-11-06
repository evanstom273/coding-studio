@tool
extends EditorPlugin
## Adds a "Visual Script" main screen that edits Coding Studio project files (.vproj.json).
## The generated .gd files are ordinary scripts: they work without this plugin.

const VisualEditor := preload("res://addons/coding_studio/visual_editor.gd")

var _editor: Control


func _enter_tree() -> void:
	_editor = VisualEditor.new()
	_editor.plugin = self
	_editor.name = "CodingStudio"
	get_editor_interface().get_editor_main_screen().add_child(_editor)
	_make_visible(false)


func _exit_tree() -> void:
	if is_instance_valid(_editor):
		_editor.queue_free()


func _has_main_screen() -> bool:
	return true


func _make_visible(visible: bool) -> void:
	if is_instance_valid(_editor):
		_editor.visible = visible


func _get_plugin_name() -> String:
	return "Visual Script"


func _get_plugin_icon() -> Texture2D:
	return get_editor_interface().get_base_control().get_theme_icon("GraphEdit", "EditorIcons")
