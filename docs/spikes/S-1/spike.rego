# SPIKE S-1 prototype policy (not the production rid.authz policy, which is M1-09).
# Allows calls with X-RID-Purpose: eligibility_check and returns the trace headers that the
# opa plugin forwards upstream (send_headers_upstream), plus two debug headers that reveal what
# OPA saw (path and route id).
package rid.spike

import rego.v1

default allow := false

purpose := object.get(input.request.headers, "x-rid-purpose", "")

# Lets the spike simulate two different clients calling from the same IP.
client := object.get(input.request.headers, "x-test-client", "anonymous")

allow if purpose == "eligibility_check"

# On allow: headers for the upstream. X-RID-End-User is deliberately NOT returned, so the plugin
# removes the clear value the client sent (it is listed in send_headers_upstream).
headers := {
	"X-RID-Consumer-Entity": "entidad-prueba",
	"X-RID-Consumer-App": sprintf("rid-app-%s", [client]),
	"X-RID-Subscription": sprintf("sub-%s", [client]),
	"X-RID-Operation": "getAfiliado",
	"X-RID-End-User-Hash": "hash-de-prueba",
	"X-RID-Debug-Path": input.request.path,
	"X-RID-Debug-Route": object.get(object.get(input, "route", {}), "id", "none"),
} if allow

# On deny: headers for the client response.
headers := {
	"Content-Type": "application/problem+json",
	# Response header: lets http-logger record why the call was denied ($sent_http_x_rid_deny_reason).
	"X-RID-Deny-Reason": "purpose_not_allowed",
} if not allow

reason := {
	"type": "https://rid.example/errors/forbidden",
	"title": "Forbidden",
	"status": 403,
	"code": "forbidden",
	"reason": "purpose_not_allowed",
} if not allow
