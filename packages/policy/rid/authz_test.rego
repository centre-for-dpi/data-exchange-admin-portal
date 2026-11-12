package rid.authz_test

import rego.v1

import data.rid.authz

# --- Fixtures -------------------------------------------------------------------------------

route_id := "rid-route-v1"

bundle := {
	"routes": {route_id: {
		"apiVersionId": "v1",
		"classification": "personal",
		"operations": [
			{
				"id": "getAfiliado", "method": "GET",
				"pathRegex": "^/salud/afiliacion/v1/afiliados/[^/]+$",
				"subject": {"in": "path", "regex": "^/salud/afiliacion/v1/afiliados/([^/]+)$", "numberGroup": 1, "documentType": "CC"},
			},
			{
				"id": "verificarAfiliacion", "method": "POST",
				"pathRegex": "^/salud/afiliacion/v1/afiliados/verificaciones$",
				"subject": {"in": "body", "documentType": "CC"},
			},
			{
				"id": "getPersona", "method": "GET",
				"pathRegex": "^/salud/afiliacion/v1/personas/[^/]+/[^/]+$",
				"subject": {"in": "path", "regex": "^/salud/afiliacion/v1/personas/([^/]+)/([^/]+)$", "numberGroup": 2, "typeGroup": 1},
			},
			{
				"id": "getEstadisticas", "method": "GET",
				"pathRegex": "^/salud/afiliacion/v1/estadisticas$",
				"subject": {"in": "none"},
			},
			{"id": "getLegado", "method": "GET", "pathRegex": "^/salud/afiliacion/v1/legado$"},
		],
	}},
	"clients": {"rid-app-a": {
		"status": "active",
		"entityId": "e1",
		"entitySlug": "programas-sociales",
		"applicationId": "a",
		"subscriptions": [{
			"id": "sub-1",
			"route": route_id,
			"operations": ["getAfiliado"],
			"purposes": ["eligibility_check"],
			"validFrom": "2026-01-01T00:00:00Z",
			"validUntil": "2027-01-01T00:00:00Z",
			"endUserRequired": true,
			"rateLimitPerMinute": 600,
		}],
		"revokedCertFingerprints": [],
	}},
	"config": {
		"endUserHashSalt": "test-salt",
		"subjectRefKey": "subject-key-for-tests-0000000000000001",
		"country": "CO",
		"documentTypes": ["CC", "CE", "TI"],
	},
}

subject_ref_of(type, number) := crypto.hmac.sha256(concat("|", ["CO", type, number]), bundle.config.subjectRefKey)

# The subscription granted every operation of the route, for data subject tests.
all_operations := with_subscription({"operations": ["getAfiliado", "verificarAfiliacion", "getPersona", "getEstadisticas", "getLegado"]})

post_verification(headers) := object.union(
	{
		"request": object.union(
			object.remove(request({}).request, ["headers", "method", "path"]),
			{
				"method": "POST",
				"path": "/salud/afiliacion/v1/afiliados/verificaciones",
				"headers": object.union(request({}).request.headers, headers),
			},
		),
	},
	{"route": {"id": route_id}},
)

get_path(path) := request({"request": {"path": path}})

headers_for(inp, data_override) := h if {
	h := authz.headers with input as inp
		with data.routes as data_override.routes
		with data.clients as data_override.clients
		with data.config as data_override.config
		with time.now_ns as june_2026
}

# 2026-06-01T00:00:00Z, inside the subscription's validity.
june_2026 := 1780272000000000000

token(claims) := io.jwt.encode_sign({"typ": "JWT", "alg": "HS256"}, claims, {"kty": "oct", "k": "c2VjcmV0"})

request(overrides) := object.union(
	{
		"request": {
			"method": "GET",
			"path": "/salud/afiliacion/v1/afiliados/1000000001",
			"headers": {
				"authorization": concat(" ", ["Bearer", token({"azp": "rid-app-a"})]),
				"x-rid-purpose": "eligibility_check",
				"x-rid-end-user": "funcionario-42",
				"x-request-id": "req-1",
			},
		},
		"route": {"id": route_id},
	},
	overrides,
)

with_headers(headers) := request({"request": {"headers": object.union(request({}).request.headers, headers)}})

# Built explicitly: object.union merges recursively, so it cannot drop a header.
without_header(name) := {
	"request": object.union(
		object.remove(request({}).request, ["headers"]),
		{"headers": object.remove(request({}).request.headers, [name])},
	),
	"route": {"id": route_id},
}

denied(inp, data_override, code) if {
	not authz.allow with input as inp
		with data.routes as data_override.routes
		with data.clients as data_override.clients
		with data.config as data_override.config
		with time.now_ns as june_2026
	authz.deny_reason == code with input as inp
		with data.routes as data_override.routes
		with data.clients as data_override.clients
		with data.config as data_override.config
		with time.now_ns as june_2026
}

with_subscription(changes) := object.union(bundle, {"clients": {"rid-app-a": {"subscriptions": [object.union(bundle.clients["rid-app-a"].subscriptions[0], changes)]}}})

# --- Allow ----------------------------------------------------------------------------------

test_allows_a_subscribed_call if {
	authz.allow with input as request({})
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
}

test_allow_sends_trace_headers_and_only_the_end_user_hash if {
	h := authz.headers with input as request({})
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
	h["X-RID-Consumer-Entity"] == "programas-sociales"
	h["X-RID-Consumer-App"] == "rid-app-a"
	h["X-RID-Subscription"] == "sub-1"
	h["X-RID-Purpose"] == "eligibility_check"
	h["X-RID-Operation"] == "getAfiliado"
	h["X-Request-Id"] == "req-1"
	h["X-RID-End-User-Hash"] == crypto.hmac.sha256("funcionario-42", "test-salt")
	not h["X-RID-End-User"]
	not h["Content-Type"]
}

test_client_credentials_tokens_without_azp_use_client_id if {
	inp := with_headers({"authorization": concat(" ", ["Bearer", token({"client_id": "rid-app-a"})])})
	authz.allow with input as inp
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
}

test_end_user_not_required_omits_the_hash if {
	b := with_subscription({"endUserRequired": false})
	h := authz.headers with input as without_header("x-rid-end-user")
		with data.routes as b.routes
		with data.clients as b.clients
		with data.config as b.config
		with time.now_ns as june_2026
	h["X-RID-Subscription"] == "sub-1"
	not h["X-RID-End-User-Hash"]
}

# --- Rule 1-2: token and client -------------------------------------------------------------

test_denies_without_a_token if {
	denied(without_header("authorization"), bundle, "no_subscription")
}

test_denies_a_malformed_authorization_header if {
	denied(with_headers({"authorization": "Basic abc"}), bundle, "no_subscription")
}

test_denies_an_unknown_client if {
	inp := with_headers({"authorization": concat(" ", ["Bearer", token({"azp": "rid-app-unknown"})])})
	denied(inp, bundle, "no_subscription")
}

test_denies_a_suspended_application if {
	b := object.union(bundle, {"clients": {"rid-app-a": {"status": "suspended"}}})
	denied(request({}), b, "app_suspended")
}

# --- Rule 3: route and operation ------------------------------------------------------------

test_denies_a_route_missing_from_the_bundle if {
	denied(request({"route": {"id": "rid-route-other"}}), bundle, "no_subscription")
}

test_denies_an_undeclared_path if {
	denied(request({"request": {"path": "/salud/afiliacion/v1/admin/usuarios"}}), bundle, "operation_not_allowed")
}

test_denies_a_method_the_path_does_not_declare if {
	denied(request({"request": {"method": "DELETE"}}), bundle, "operation_not_allowed")
}

test_path_regex_is_anchored if {
	denied(request({"request": {"path": "/salud/afiliacion/v1/afiliados/1/extra"}}), bundle, "operation_not_allowed")
}

# --- Rule 4: subscription, operation, purpose, validity -------------------------------------

test_denies_a_client_without_subscription_to_the_route if {
	b := object.union(bundle, {"clients": {"rid-app-a": {"subscriptions": []}}})
	denied(request({}), b, "no_subscription")
}

test_denies_an_operation_not_granted if {
	inp := request({"request": {"method": "POST", "path": "/salud/afiliacion/v1/afiliados/verificaciones"}})
	denied(inp, bundle, "operation_not_allowed")
}

test_denies_a_purpose_not_granted if {
	denied(with_headers({"x-rid-purpose": "benefit_targeting"}), bundle, "purpose_not_allowed")
}

test_denies_without_a_purpose if {
	denied(without_header("x-rid-purpose"), bundle, "purpose_not_allowed")
}

test_a_repeated_purpose_header_counts_as_absent if {
	denied(with_headers({"x-rid-purpose": ["eligibility_check", "benefit_targeting"]}), bundle, "purpose_not_allowed")
}

test_denies_an_expired_subscription if {
	denied(request({}), with_subscription({"validUntil": "2026-05-31T23:59:59Z"}), "subscription_expired")
}

test_denies_a_subscription_not_yet_valid if {
	denied(request({}), with_subscription({"validFrom": "2026-07-01T00:00:00Z"}), "subscription_expired")
}

# --- Rule 5: end user -----------------------------------------------------------------------

test_denies_without_end_user_when_required if {
	denied(without_header("x-rid-end-user"), bundle, "end_user_required")
}

# --- Data subject (ADR-0015) ----------------------------------------------------------------

test_the_path_subject_becomes_a_keyed_reference if {
	h := headers_for(request({}), bundle)
	h["X-RID-Subject-Ref"] == subject_ref_of("CC", "1000000001")
}

test_the_same_person_gets_the_same_reference_and_another_a_different_one if {
	formatted := headers_for(get_path("/salud/afiliacion/v1/afiliados/1.000.000.001"), bundle)
	formatted["X-RID-Subject-Ref"] == subject_ref_of("CC", "1000000001")
	other := headers_for(get_path("/salud/afiliacion/v1/afiliados/1000000002"), bundle)
	other["X-RID-Subject-Ref"] != formatted["X-RID-Subject-Ref"]
}

test_the_document_type_may_come_from_the_path if {
	h := headers_for(get_path("/salud/afiliacion/v1/personas/ce/123456"), all_operations)
	h["X-RID-Subject-Ref"] == subject_ref_of("CE", "123456")
}

test_an_unknown_document_type_is_denied if {
	denied(get_path("/salud/afiliacion/v1/personas/xx/123456"), all_operations, "data_subject_required")
}

test_a_malformed_number_is_denied if {
	denied(get_path("/salud/afiliacion/v1/afiliados/12"), bundle, "data_subject_required")
	denied(get_path("/salud/afiliacion/v1/afiliados/1000%2F0001"), bundle, "data_subject_required")
}

test_the_body_subject_read_by_the_gateway_becomes_a_reference if {
	h := headers_for(post_verification({"x-rid-body-subject": "CC:1000000001"}), all_operations)
	h["X-RID-Subject-Ref"] == subject_ref_of("CC", "1000000001")
	not h["X-RID-Body-Subject"]
	not h["x-rid-body-subject"]
}

test_a_bare_number_uses_the_operation_document_type if {
	h := headers_for(post_verification({"x-rid-body-subject": " 1000000001 "}), all_operations)
	h["X-RID-Subject-Ref"] == subject_ref_of("CC", "1000000001")
}

test_an_operation_with_a_body_subject_requires_it if {
	denied(post_verification({}), all_operations, "data_subject_required")
	denied(post_verification({"x-rid-body-subject": ["CC:1000000001", "CC:1000000002"]}), all_operations, "data_subject_required")
	denied(post_verification({"x-rid-body-subject": "CC:1000:0001"}), all_operations, "data_subject_required")
	denied(post_verification({"x-rid-body-subject": "XX:1000000001"}), all_operations, "data_subject_required")
}

test_operations_without_a_subject_carry_no_reference if {
	none := headers_for(get_path("/salud/afiliacion/v1/estadisticas"), all_operations)
	none["X-RID-Subscription"] == "sub-1"
	not none["X-RID-Subject-Ref"]
}

test_personal_data_without_a_valid_declaration_fails_closed if {
	# A stale version (no declaration, or one no longer accepted) cannot say whose data it is.
	denied(get_path("/salud/afiliacion/v1/legado"), all_operations, "data_subject_required")
	denied(get_path("/salud/afiliacion/v1/legado"), sensitive_route(all_operations), "data_subject_required")
}

test_public_data_without_a_declaration_is_allowed if {
	h := headers_for(get_path("/salud/afiliacion/v1/legado"), public_route(all_operations))
	h["X-RID-Subscription"] == "sub-1"
	not h["X-RID-Subject-Ref"]
}

with_classification(b, classification) := object.union(b, {"routes": {route_id: object.union(b.routes[route_id], {"classification": classification})}})

sensitive_route(b) := with_classification(b, "sensitive")

public_route(b) := with_classification(b, "public")

test_a_denial_never_carries_the_reference if {
	h := headers_for(with_headers({"x-rid-purpose": "benefit_targeting"}), bundle)
	not h["X-RID-Subject-Ref"]
}

test_the_consumer_cannot_assert_the_subject_in_a_header if {
	# Only the gateway plugin sets x-rid-body-subject; the old consumer header is ignored.
	denied(post_verification({"x-rid-data-subject": "CC:1000000001"}), all_operations, "data_subject_required")
}

# --- Rule 6: deny response ------------------------------------------------------------------

test_deny_returns_problem_json_and_the_reason_header if {
	inp := with_headers({"x-rid-purpose": "benefit_targeting"})
	h := authz.headers with input as inp
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
	h == {"Content-Type": "application/problem+json", "X-RID-Deny-Reason": "purpose_not_allowed"}
	body := authz.reason with input as inp
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
	body.code == "purpose_not_allowed"
	body.status == 403
	body.type == "https://rid.example/errors/purpose_not_allowed"
	authz.status_code == 403 with input as inp
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
}

test_denies_everything_without_data if {
	not authz.allow with input as request({})
	authz.deny_reason == "no_subscription" with input as request({})
}
