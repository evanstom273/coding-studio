/**
 * A curated subset of the Godot 4 API, turned into nodes automatically (see nodes.ts).
 * Signatures follow the Godot 4.x class reference. Parameters typed StringName/NodePath in the
 * engine are declared as `string` here: GDScript converts String arguments implicitly.
 */

export type ApiParam = [name: string, type: string, defaultValue?: number | string | boolean];

export interface ApiMember {
  /** Engine class, a singleton name (singleton: true), or '@GlobalScope'. */
  cls: string;
  name: string;
  kind: 'method' | 'property' | 'function';
  params?: ApiParam[];
  /** Return type (methods/functions) or property type. */
  type: string;
  /** Methods without side effects become pure nodes. */
  pure?: boolean;
  readonly?: boolean;
  singleton?: boolean;
  /** Value type (Vector2…): target must be connected. */
  valueType?: boolean;
  description: string;
  keywords?: string[];
  title?: string;
}

const m = (cls: string, name: string, type: string, params: ApiParam[], description: string, extra: Partial<ApiMember> = {}): ApiMember => ({ cls, name, kind: 'method', type, params, description, ...extra });
const p = (cls: string, name: string, type: string, description: string, extra: Partial<ApiMember> = {}): ApiMember => ({ cls, name, kind: 'property', type, description, ...extra });
const g = (name: string, type: string, params: ApiParam[], description: string, extra: Partial<ApiMember> = {}): ApiMember => ({ cls: '@GlobalScope', name, kind: 'function', type, params, description, pure: true, ...extra });

export const GODOT_API: ApiMember[] = [
  // --- Node -------------------------------------------------------------------
  m('Node', 'get_tree', 'SceneTree', [], 'The SceneTree this node is in.', { pure: true }),
  m('Node', 'get_parent', 'Node', [], 'The parent node.', { pure: true }),
  m('Node', 'get_viewport', 'Viewport', [], 'The viewport this node is drawn in.', { pure: true }),
  m('Node', 'has_node', 'bool', [['path', 'NodePath']], 'Whether a node exists at the path.', { pure: true }),
  m('Node', 'get_children', 'array<Node>', [], 'All direct children.', { pure: true }),
  m('Node', 'queue_free', 'void', [], 'Delete this node at the end of the frame.', { keywords: ['destroy', 'delete', 'remove'] }),
  m('Node', 'add_child', 'void', [['node', 'Node']], 'Add a child node.', { keywords: ['spawn', 'attach'] }),
  m('Node', 'remove_child', 'void', [['node', 'Node']], 'Remove a child node (does not free it).'),
  m('Node', 'add_to_group', 'void', [['group', 'string']], 'Add this node to a group.'),
  m('Node', 'is_in_group', 'bool', [['group', 'string']], 'Whether this node is in a group.', { pure: true }),
  m('Node', 'set_process', 'void', [['enable', 'bool']], 'Enable or disable _process.'),
  m('Node', 'set_physics_process', 'void', [['enable', 'bool']], 'Enable or disable _physics_process.'),
  m('Node', 'set_process_input', 'void', [['enable', 'bool']], 'Enable or disable _input.'),
  // --- SceneTree --------------------------------------------------------------
  m('SceneTree', 'change_scene_to_file', 'int', [['path', 'string']], 'Switch to another scene file (res://…). Returns an Error code.', { keywords: ['load level', 'scene'] }),
  m('SceneTree', 'reload_current_scene', 'int', [], 'Reload the current scene. Returns an Error code.', { keywords: ['restart'] }),
  m('SceneTree', 'quit', 'void', [['exit_code', 'int', 0]], 'Quit the game.', { keywords: ['exit'] }),
  m('SceneTree', 'create_timer', 'SceneTreeTimer', [['time_sec', 'float', 1]], 'A one-shot timer; await its "timeout" signal.'),
  m('SceneTree', 'get_first_node_in_group', 'Node', [['group', 'string']], 'The first node in a group, or null.', { pure: true }),
  p('SceneTree', 'paused', 'bool', 'Whether the game is paused.'),
  // --- CanvasItem / Node2D ----------------------------------------------------
  p('CanvasItem', 'visible', 'bool', 'Whether the item is drawn.'),
  p('CanvasItem', 'modulate', 'Color', 'Colour tint (inherited by children).'),
  m('CanvasItem', 'show', 'void', [], 'Make visible.'),
  m('CanvasItem', 'hide', 'void', [], 'Make invisible.'),
  m('CanvasItem', 'get_global_mouse_position', 'Vector2', [], 'Mouse position in world coordinates.', { pure: true }),
  m('CanvasItem', 'queue_redraw', 'void', [], 'Request _draw to run again.'),
  p('Node2D', 'position', 'Vector2', 'Position relative to the parent.'),
  p('Node2D', 'global_position', 'Vector2', 'Position in world coordinates.'),
  p('Node2D', 'rotation', 'float', 'Rotation in radians.'),
  p('Node2D', 'rotation_degrees', 'float', 'Rotation in degrees.'),
  p('Node2D', 'scale', 'Vector2', 'Scale.'),
  m('Node2D', 'rotate', 'void', [['radians', 'float']], 'Rotate by an angle (radians).'),
  m('Node2D', 'translate', 'void', [['offset', 'Vector2']], 'Move by an offset.'),
  m('Node2D', 'look_at', 'void', [['point', 'Vector2']], 'Rotate to point at a world position.'),
  p('Sprite2D', 'flip_h', 'bool', 'Mirror horizontally.'),
  p('Sprite2D', 'flip_v', 'bool', 'Mirror vertically.'),
  p('Sprite2D', 'texture', 'Texture2D', 'The texture drawn.'),
  m('AnimatedSprite2D', 'play', 'void', [['name', 'string', '']], 'Play an animation (empty = current).'),
  m('AnimatedSprite2D', 'stop', 'void', [], 'Stop the animation.'),
  p('AnimatedSprite2D', 'flip_h', 'bool', 'Mirror horizontally.'),
  p('AnimatedSprite2D', 'animation', 'string', 'Current animation name.'),
  m('Camera2D', 'make_current', 'void', [], 'Make this the active camera.'),
  p('Camera2D', 'zoom', 'Vector2', 'Zoom factor.'),
  // --- Bodies 2D ---------------------------------------------------------------
  p('CharacterBody2D', 'velocity', 'Vector2', 'Current velocity in pixels per second, used by move_and_slide.'),
  p('CharacterBody2D', 'up_direction', 'Vector2', 'Which way is up (for floor detection).'),
  m('CharacterBody2D', 'move_and_slide', 'bool', [], 'Move using velocity, sliding along collisions. Returns true on collision.', { keywords: ['move', 'physics', 'walk'] }),
  m('CharacterBody2D', 'is_on_floor', 'bool', [], 'Whether the body touched the floor on the last move_and_slide.', { pure: true, keywords: ['grounded', 'jump'] }),
  m('CharacterBody2D', 'is_on_wall', 'bool', [], 'Whether the body touched a wall on the last move_and_slide.', { pure: true }),
  m('CharacterBody2D', 'is_on_ceiling', 'bool', [], 'Whether the body touched the ceiling on the last move_and_slide.', { pure: true }),
  m('Area2D', 'get_overlapping_bodies', 'array<Node2D>', [], 'Physics bodies currently inside the area.', { pure: true }),
  m('RayCast2D', 'is_colliding', 'bool', [], 'Whether the ray hits something.', { pure: true }),
  m('RayCast2D', 'get_collider', 'Object', [], 'The object the ray hits, or null.', { pure: true }),
  // --- Node3D ------------------------------------------------------------------
  p('Node3D', 'position', 'Vector3', 'Position relative to the parent.'),
  p('Node3D', 'global_position', 'Vector3', 'Position in world coordinates.'),
  p('Node3D', 'rotation', 'Vector3', 'Euler rotation in radians.'),
  p('Node3D', 'scale', 'Vector3', 'Scale.'),
  p('Node3D', 'transform', 'Transform3D', 'Local transform.'),
  p('Node3D', 'global_transform', 'Transform3D', 'World transform.'),
  p('Node3D', 'basis', 'Basis', 'Rotation/scale basis of the local transform.'),
  p('Node3D', 'visible', 'bool', 'Whether the node is drawn.'),
  m('Node3D', 'rotate_x', 'void', [['angle', 'float']], 'Rotate around the X axis (radians).', { keywords: ['pitch'] }),
  m('Node3D', 'rotate_y', 'void', [['angle', 'float']], 'Rotate around the Y axis (radians).', { keywords: ['yaw', 'turn'] }),
  m('Node3D', 'rotate_z', 'void', [['angle', 'float']], 'Rotate around the Z axis (radians).', { keywords: ['roll'] }),
  m('Node3D', 'rotate_object_local', 'void', [['axis', 'Vector3'], ['angle', 'float']], 'Rotate around a local axis.'),
  m('Node3D', 'translate', 'void', [['offset', 'Vector3']], 'Move by a local offset.'),
  m('Node3D', 'look_at', 'void', [['target', 'Vector3'], ['up', 'Vector3']], 'Rotate so -Z points at a world position.'),
  m('Camera3D', 'make_current', 'void', [], 'Make this the active camera.'),
  p('Camera3D', 'fov', 'float', 'Vertical field of view in degrees.'),
  // --- Bodies 3D ---------------------------------------------------------------
  p('CharacterBody3D', 'velocity', 'Vector3', 'Current velocity in metres per second, used by move_and_slide.'),
  m('CharacterBody3D', 'move_and_slide', 'bool', [], 'Move using velocity, sliding along collisions. Returns true on collision.', { keywords: ['move', 'physics', 'walk'] }),
  m('CharacterBody3D', 'is_on_floor', 'bool', [], 'Whether the body touched the floor on the last move_and_slide.', { pure: true, keywords: ['grounded', 'jump'] }),
  m('CharacterBody3D', 'is_on_wall', 'bool', [], 'Whether the body touched a wall on the last move_and_slide.', { pure: true }),
  m('CharacterBody3D', 'is_on_ceiling', 'bool', [], 'Whether the body touched the ceiling on the last move_and_slide.', { pure: true }),
  m('Area3D', 'get_overlapping_bodies', 'array<Node3D>', [], 'Physics bodies currently inside the area.', { pure: true }),
  m('RayCast3D', 'is_colliding', 'bool', [], 'Whether the ray hits something.', { pure: true }),
  m('RayCast3D', 'get_collider', 'Object', [], 'The object the ray hits, or null.', { pure: true }),
  m('RayCast3D', 'force_raycast_update', 'void', [], 'Update the ray immediately.'),
  // --- Timer / animation / audio -------------------------------------------------
  m('Timer', 'start', 'void', [['time_sec', 'float', -1]], 'Start (or restart) the timer. -1 uses wait_time.'),
  m('Timer', 'stop', 'void', [], 'Stop the timer.'),
  m('Timer', 'is_stopped', 'bool', [], 'Whether the timer is stopped.', { pure: true }),
  p('Timer', 'wait_time', 'float', 'Seconds between timeouts.'),
  p('Timer', 'one_shot', 'bool', 'Stop after one timeout.'),
  p('Timer', 'time_left', 'float', 'Seconds until the next timeout.', { readonly: true }),
  p('Timer', 'paused', 'bool', 'Whether the timer is paused.'),
  m('AnimationPlayer', 'play', 'void', [['name', 'string', '']], 'Play an animation by name (empty = current).'),
  m('AnimationPlayer', 'play_backwards', 'void', [['name', 'string', '']], 'Play an animation in reverse.'),
  m('AnimationPlayer', 'queue', 'void', [['name', 'string']], 'Play an animation after the current one finishes.'),
  m('AnimationPlayer', 'stop', 'void', [], 'Stop the current animation.'),
  m('AnimationPlayer', 'is_playing', 'bool', [], 'Whether an animation is playing.', { pure: true }),
  p('AnimationPlayer', 'current_animation', 'string', 'Name of the playing animation.'),
  p('AnimationPlayer', 'speed_scale', 'float', 'Playback speed multiplier.'),
  m('AudioStreamPlayer', 'play', 'void', [['from_position', 'float', 0]], 'Play the sound.', { keywords: ['sound', 'sfx', 'music'] }),
  m('AudioStreamPlayer', 'stop', 'void', [], 'Stop the sound.'),
  p('AudioStreamPlayer', 'playing', 'bool', 'Whether the sound is playing.', { readonly: true }),
  p('AudioStreamPlayer', 'volume_db', 'float', 'Volume in decibels.'),
  p('AudioStreamPlayer', 'pitch_scale', 'float', 'Pitch/speed multiplier.'),
  p('AudioStreamPlayer', 'stream', 'AudioStream', 'The sound to play.'),
  m('AudioStreamPlayer2D', 'play', 'void', [['from_position', 'float', 0]], 'Play the positional sound.', { keywords: ['sound', 'sfx'] }),
  m('AudioStreamPlayer3D', 'play', 'void', [['from_position', 'float', 0]], 'Play the positional sound.', { keywords: ['sound', 'sfx'] }),
  // --- Resources -----------------------------------------------------------------
  m('PackedScene', 'instantiate', 'Node', [], 'Create a node tree from the scene.', { keywords: ['spawn', 'instance', 'create'] }),
  // --- Input events ---------------------------------------------------------------
  m('InputEvent', 'is_action_pressed', 'bool', [['action', 'string']], 'Whether this event presses an input action.', { pure: true }),
  m('InputEvent', 'is_action_released', 'bool', [['action', 'string']], 'Whether this event releases an input action.', { pure: true }),
  m('InputEvent', 'is_pressed', 'bool', [], 'Whether this is a press event.', { pure: true }),
  p('InputEventMouseMotion', 'relative', 'Vector2', 'Mouse movement since the last event, in pixels.', { readonly: true, keywords: ['mouse look', 'delta'] }),
  p('InputEventMouse', 'position', 'Vector2', 'Mouse position in the viewport.', { readonly: true }),
  p('InputEventMouseButton', 'button_index', 'int', 'Which mouse button (compare with MOUSE_BUTTON_LEFT…).', { readonly: true }),
  p('InputEventMouseButton', 'pressed', 'bool', 'Whether the button was pressed (false = released).', { readonly: true }),
  p('InputEventKey', 'keycode', 'int', 'Key code (compare with KEY_…).', { readonly: true }),
  p('InputEventKey', 'pressed', 'bool', 'Whether the key was pressed (false = released).', { readonly: true }),
  // --- Input singleton --------------------------------------------------------------
  m('Input', 'is_action_pressed', 'bool', [['action', 'string', 'ui_accept']], 'Whether an input action is held.', { pure: true, singleton: true, keywords: ['key', 'button', 'held'] }),
  m('Input', 'is_action_just_pressed', 'bool', [['action', 'string', 'ui_accept']], 'Whether an input action was pressed this frame.', { pure: true, singleton: true, keywords: ['key', 'button', 'jump'] }),
  m('Input', 'is_action_just_released', 'bool', [['action', 'string', 'ui_accept']], 'Whether an input action was released this frame.', { pure: true, singleton: true }),
  m('Input', 'get_action_strength', 'float', [['action', 'string', 'ui_accept']], 'Analogue strength 0–1 of an input action.', { pure: true, singleton: true }),
  m('Input', 'get_axis', 'float', [['negative_action', 'string', 'ui_left'], ['positive_action', 'string', 'ui_right']], 'Axis value from two actions (-1…1).', { pure: true, singleton: true, keywords: ['horizontal', 'direction'] }),
  m(
    'Input',
    'get_vector',
    'Vector2',
    [
      ['negative_x', 'string', 'ui_left'],
      ['positive_x', 'string', 'ui_right'],
      ['negative_y', 'string', 'ui_up'],
      ['positive_y', 'string', 'ui_down'],
    ],
    'Direction vector from four actions (length ≤ 1).',
    { pure: true, singleton: true, keywords: ['movement', 'direction', 'wasd'] },
  ),
  m('Input', 'is_mouse_button_pressed', 'bool', [['button', 'int', 1]], 'Whether a mouse button is held (1 = left).', { pure: true, singleton: true }),
  m('Input', 'is_key_pressed', 'bool', [['keycode', 'int']], 'Whether a key is held (KEY_… constant).', { pure: true, singleton: true }),
  m('ProjectSettings', 'get_setting', 'any', [['name', 'string', 'physics/2d/default_gravity']], 'Read a project setting (e.g. physics/3d/default_gravity).', { pure: true, singleton: true, keywords: ['gravity', 'config'] }),
  m('Time', 'get_ticks_msec', 'int', [], 'Milliseconds since the engine started.', { pure: true, singleton: true, keywords: ['clock', 'time'] }),
  // --- Value types ---------------------------------------------------------------------
  m('Vector2', 'length', 'float', [], 'Length of the vector.', { pure: true, valueType: true, keywords: ['magnitude'] }),
  m('Vector2', 'normalized', 'Vector2', [], 'Unit-length copy (or zero).', { pure: true, valueType: true }),
  m('Vector2', 'dot', 'float', [['with', 'Vector2']], 'Dot product.', { pure: true, valueType: true }),
  m('Vector2', 'distance_to', 'float', [['to', 'Vector2']], 'Distance to another point.', { pure: true, valueType: true }),
  m('Vector2', 'direction_to', 'Vector2', [['to', 'Vector2']], 'Unit direction to another point.', { pure: true, valueType: true }),
  m('Vector2', 'angle', 'float', [], 'Angle in radians relative to +X.', { pure: true, valueType: true }),
  m('Vector2', 'rotated', 'Vector2', [['angle', 'float']], 'Copy rotated by an angle (radians).', { pure: true, valueType: true }),
  m('Vector2', 'lerp', 'Vector2', [['to', 'Vector2'], ['weight', 'float', 0.5]], 'Interpolate towards another vector.', { pure: true, valueType: true }),
  m('Vector2', 'move_toward', 'Vector2', [['to', 'Vector2'], ['delta', 'float']], 'Move towards another vector by at most delta.', { pure: true, valueType: true }),
  m('Vector2', 'limit_length', 'Vector2', [['length', 'float', 1]], 'Copy with length clamped.', { pure: true, valueType: true }),
  m('Vector3', 'length', 'float', [], 'Length of the vector.', { pure: true, valueType: true, keywords: ['magnitude'] }),
  m('Vector3', 'normalized', 'Vector3', [], 'Unit-length copy (or zero).', { pure: true, valueType: true }),
  m('Vector3', 'dot', 'float', [['with', 'Vector3']], 'Dot product.', { pure: true, valueType: true }),
  m('Vector3', 'cross', 'Vector3', [['with', 'Vector3']], 'Cross product.', { pure: true, valueType: true }),
  m('Vector3', 'distance_to', 'float', [['to', 'Vector3']], 'Distance to another point.', { pure: true, valueType: true }),
  m('Vector3', 'direction_to', 'Vector3', [['to', 'Vector3']], 'Unit direction to another point.', { pure: true, valueType: true }),
  m('Vector3', 'rotated', 'Vector3', [['axis', 'Vector3'], ['angle', 'float']], 'Copy rotated around a unit axis.', { pure: true, valueType: true }),
  m('Vector3', 'lerp', 'Vector3', [['to', 'Vector3'], ['weight', 'float', 0.5]], 'Interpolate towards another vector.', { pure: true, valueType: true }),
  m('Vector3', 'move_toward', 'Vector3', [['to', 'Vector3'], ['delta', 'float']], 'Move towards another vector by at most delta.', { pure: true, valueType: true }),
  // --- Global functions -------------------------------------------------------------------
  g('deg_to_rad', 'float', [['deg', 'float']], 'Degrees to radians.', { keywords: ['angle', 'convert'] }),
  g('rad_to_deg', 'float', [['rad', 'float']], 'Radians to degrees.', { keywords: ['angle', 'convert'] }),
  g('move_toward', 'float', [['from', 'float'], ['to', 'float'], ['delta', 'float']], 'Move a value towards a target by at most delta.', { keywords: ['approach', 'friction'] }),
  g('lerp_angle', 'float', [['from', 'float'], ['to', 'float'], ['weight', 'float', 0.5]], 'Interpolate between angles, taking the short way round.'),
  g('wrapf', 'float', [['value', 'float'], ['min', 'float'], ['max', 'float', 1]], 'Wrap a value into [min, max).'),
  g('signf', 'float', [['x', 'float']], 'Sign of x: -1, 0 or 1.'),
  g('fmod', 'float', [['x', 'float'], ['y', 'float', 1]], 'Floating-point remainder.'),
  g('randf_range', 'float', [['from', 'float'], ['to', 'float', 1]], 'Random float in a range.', { keywords: ['random'] }),
  g('is_instance_valid', 'bool', [['instance', 'any']], 'Whether an object reference is still alive (not freed).', { keywords: ['valid', 'alive', 'freed'] }),
];
