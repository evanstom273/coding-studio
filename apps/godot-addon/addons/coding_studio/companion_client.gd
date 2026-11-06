@tool
extends Node
## Minimal JSON-over-HTTP client for the local Coding Studio companion service.
## Each call returns { "ok": bool, "data": Variant, "error": { code, message } }.

var base_url := "http://127.0.0.1:47832"


func call_api(method: int, path: String, body: Variant = null) -> Dictionary:
	var http := HTTPRequest.new()
	http.timeout = 30.0
	add_child(http)
	var headers := PackedStringArray(["Content-Type: application/json"])
	var payload := "" if body == null else JSON.stringify(body)
	var err := http.request(base_url + path, headers, method, payload)
	if err != OK:
		http.queue_free()
		return _fail("E_REQUEST", "Could not start the request (%s)." % error_string(err))
	var res: Array = await http.request_completed
	http.queue_free()
	var result: int = res[0]
	var code: int = res[1]
	var text: String = (res[3] as PackedByteArray).get_string_from_utf8()
	if result != HTTPRequest.RESULT_SUCCESS:
		return _fail("E_COMPANION_OFFLINE", "The Coding Studio companion is not running on %s. Start it from the Coding Studio repository with: npm run build:companion && npm run companion" % base_url)
	var parsed: Variant = JSON.parse_string(text)
	if code >= 400:
		if parsed is Dictionary and parsed.has("error"):
			return {"ok": false, "data": null, "error": parsed["error"]}
		return _fail("E_HTTP_%d" % code, text)
	return {"ok": true, "data": parsed, "error": null}


func get_json(path: String) -> Dictionary:
	return await call_api(HTTPClient.METHOD_GET, path)


func post_json(path: String, body: Variant) -> Dictionary:
	return await call_api(HTTPClient.METHOD_POST, path, body)


func _fail(code: String, message: String) -> Dictionary:
	return {"ok": false, "data": null, "error": {"code": code, "message": message}}
