package den.authz_test

import rego.v1

import data.den.authz

# --- Fixtures -------------------------------------------------------------------------------

route_id := "den-route-v1"

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
	"clients": {"den-app-a": {
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
		"certificates": ["thumb-a"],
	}},
	"config": {
		"endUserHashSalt": "test-salt",
		"subjectRefKey": "subject-key-for-tests-0000000000000001",
		"country": "CO",
		"documentTypes": ["CC", "CE", "TI"],
		# TI has no format of its own: only the shape every number keeps to (ADR-0030).
		"documentNumberFormats": {"CC": "^[1-9][0-9]{2,9}$", "CE": "^[1-9][0-9]{2,9}$"},
		"mtlsRequired": false,
		"gatewayNodes": 1,
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
				"authorization": concat(" ", ["Bearer", token({"azp": "den-app-a"})]),
				"x-den-purpose": "eligibility_check",
				"x-den-end-user": "funcionario-42",
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

with_subscription(changes) := object.union(bundle, {"clients": {"den-app-a": {"subscriptions": [object.union(bundle.clients["den-app-a"].subscriptions[0], changes)]}}})

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
	h["X-DEN-Consumer-Entity"] == "programas-sociales"
	h["X-DEN-Consumer-App"] == "den-app-a"
	h["X-DEN-Subscription"] == "sub-1"
	h["X-DEN-Purpose"] == "eligibility_check"
	h["X-DEN-Operation"] == "getAfiliado"
	h["X-Request-Id"] == "req-1"
	h["X-DEN-End-User-Hash"] == crypto.hmac.sha256("funcionario-42", "test-salt")
	not h["X-DEN-End-User"]
	not h["Content-Type"]
}

test_client_credentials_tokens_without_azp_use_client_id if {
	inp := with_headers({"authorization": concat(" ", ["Bearer", token({"client_id": "den-app-a"})])})
	authz.allow with input as inp
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
}

test_end_user_not_required_omits_the_hash if {
	# Neither the subscription nor the classification asks for it.
	b := json.patch(with_subscription({"endUserRequired": false}), [{"op": "replace", "path": "/routes/den-route-v1/classification", "value": "internal"}])
	h := authz.headers with input as without_header("x-den-end-user")
		with data.routes as b.routes
		with data.clients as b.clients
		with data.config as b.config
		with time.now_ns as june_2026
	h["X-DEN-Subscription"] == "sub-1"
	not h["X-DEN-End-User-Hash"]
}

# --- Rule 1-2: token and client -------------------------------------------------------------

test_denies_without_a_token if {
	denied(without_header("authorization"), bundle, "no_subscription")
}

test_denies_a_malformed_authorization_header if {
	denied(with_headers({"authorization": "Basic abc"}), bundle, "no_subscription")
}

test_denies_an_unknown_client if {
	inp := with_headers({"authorization": concat(" ", ["Bearer", token({"azp": "den-app-unknown"})])})
	denied(inp, bundle, "no_subscription")
}

test_denies_a_suspended_application if {
	b := object.union(bundle, {"clients": {"den-app-a": {"status": "suspended"}}})
	denied(request({}), b, "app_suspended")
}

# --- Rule 3: route and operation ------------------------------------------------------------

test_denies_a_route_missing_from_the_bundle if {
	denied(request({"route": {"id": "den-route-other"}}), bundle, "no_subscription")
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

# A route whose GET operations are `paths` (operation id -> pathRegex), all granted, internal data.
with_get_operations(paths) := object.union(bundle, {
	"routes": {route_id: {
		"apiVersionId": "v1",
		"classification": "internal",
		"operations": [{"id": id, "method": "GET", "pathRegex": regex, "subject": {"in": "none"}} |
			some id, regex in paths
		],
	}},
	"clients": {"den-app-a": {"subscriptions": [object.union(
		bundle.clients["den-app-a"].subscriptions[0],
		{"operations": [id | some id, _ in paths]},
	)]}},
})

operation_for(path, b) := headers_for(get_path(path), b)["X-DEN-Operation"]

# M-13: GET /afiliados/{id} and GET /afiliados/buscar are valid OpenAPI; both match the literal
# path, and the literal one wins instead of an eval_conflict_error (5xx on every call).
literal_and_parameter := with_get_operations({
	"getAfiliado": "^/salud/afiliacion/v1/afiliados/[^/]+$",
	"buscarAfiliados": "^/salud/afiliacion/v1/afiliados/buscar$",
})

test_a_literal_path_next_to_a_parameter_wins if {
	operation_for("/salud/afiliacion/v1/afiliados/buscar", literal_and_parameter) == "buscarAfiliados"
}

test_the_parameter_path_next_to_a_literal_still_works if {
	operation_for("/salud/afiliacion/v1/afiliados/1000000001", literal_and_parameter) == "getAfiliado"
}

test_a_partly_literal_segment_beats_a_whole_parameter if {
	b := with_get_operations({
		"getArchivo": "^/salud/afiliacion/v1/archivos/[^/]+$",
		"getArchivoJson": "^/salud/afiliacion/v1/archivos/[^/]+\\.json$",
		"getIndice": "^/salud/afiliacion/v1/archivos/indice\\.json$",
	})
	operation_for("/salud/afiliacion/v1/archivos/a.json", b) == "getArchivoJson"
	operation_for("/salud/afiliacion/v1/archivos/a.xml", b) == "getArchivo"
	operation_for("/salud/afiliacion/v1/archivos/indice.json", b) == "getIndice"
}

test_segments_compare_from_the_left if {
	b := with_get_operations({
		"porTipo": "^/salud/afiliacion/v1/[^/]+/resumen$",
		"afiliadoPorId": "^/salud/afiliacion/v1/afiliados/[^/]+$",
	})
	operation_for("/salud/afiliacion/v1/afiliados/resumen", b) == "afiliadoPorId"
	operation_for("/salud/afiliacion/v1/hogares/resumen", b) == "porTipo"
}

test_two_equally_specific_matches_fail_closed if {
	b := with_get_operations({
		"porNombre": "^/salud/afiliacion/v1/afiliados/[^/]+$",
		"porCodigo": "^/salud/afiliacion/v1/afiliados/[^/]+$",
	})
	denied(get_path("/salud/afiliacion/v1/afiliados/1000000001"), b, "operation_not_allowed")
}

# --- Rule 4: subscription, operation, purpose, validity -------------------------------------

test_denies_a_client_without_subscription_to_the_route if {
	b := object.union(bundle, {"clients": {"den-app-a": {"subscriptions": []}}})
	denied(request({}), b, "no_subscription")
}

test_denies_an_operation_not_granted if {
	inp := request({"request": {"method": "POST", "path": "/salud/afiliacion/v1/afiliados/verificaciones"}})
	denied(inp, bundle, "operation_not_allowed")
}

test_denies_a_purpose_not_granted if {
	denied(with_headers({"x-den-purpose": "benefit_targeting"}), bundle, "purpose_not_allowed")
}

test_denies_without_a_purpose if {
	denied(without_header("x-den-purpose"), bundle, "purpose_not_allowed")
}

test_a_repeated_purpose_header_counts_as_absent if {
	denied(with_headers({"x-den-purpose": ["eligibility_check", "benefit_targeting"]}), bundle, "purpose_not_allowed")
}

test_denies_an_expired_subscription if {
	denied(request({}), with_subscription({"validUntil": "2026-05-31T23:59:59Z"}), "subscription_expired")
}

test_denies_a_subscription_not_yet_valid if {
	denied(request({}), with_subscription({"validFrom": "2026-07-01T00:00:00Z"}), "subscription_expired")
}

# --- Rule 5: end user -----------------------------------------------------------------------

test_denies_without_end_user_when_required if {
	denied(without_header("x-den-end-user"), bundle, "end_user_required")
}

# --- Data subject (ADR-0015) ----------------------------------------------------------------

test_the_path_subject_becomes_a_keyed_reference if {
	h := headers_for(request({}), bundle)
	h["X-DEN-Subject-Ref"] == subject_ref_of("CC", "1000000001")
}

# Shared vector with the portal API (apps/api/src/transparency/subject-ref.test.ts): the citizen
# API derives the reference from the citizen's token and must get exactly what the gateway put
# in X-DEN-Subject-Ref.
test_the_reference_matches_the_portal_vector if {
	h := headers_for(request({}), bundle)
	h["X-DEN-Subject-Ref"] == "0d0deea2958985c2da0174f52dfb3bd1a9a88d0115ce41a4a3d1166e889b9062"
}

test_another_person_gets_another_reference if {
	one := headers_for(get_path("/salud/afiliacion/v1/afiliados/1000000001"), bundle)
	other := headers_for(get_path("/salud/afiliacion/v1/afiliados/1000000002"), bundle)
	other["X-DEN-Subject-Ref"] != one["X-DEN-Subject-Ref"]
}

# M-12: one person, one spelling. A provider that reads the number as an integer, strips separators
# or ignores case would answer with the same person's data, while any other spelling would give
# another reference and the citizen, whose reference comes from the canonical number, would never
# see the consultation. Every other spelling is denied, so the provider only ever gets the
# canonical one.
test_another_spelling_of_the_number_is_denied if {
	every number in ["0001000000001", "01000000001", "1.000.000.001", "1000000-001", "1000000001%20"] {
		denied(get_path(concat("/", ["/salud/afiliacion/v1/afiliados", number])), bundle, "data_subject_invalid")
	}
}

test_a_denied_spelling_never_carries_a_reference if {
	h := headers_for(get_path("/salud/afiliacion/v1/afiliados/0001000000001"), bundle)
	not h["X-DEN-Subject-Ref"]
	h["X-DEN-Deny-Reason"] == "data_subject_invalid"
}

test_the_document_type_may_come_from_the_path if {
	h := headers_for(get_path("/salud/afiliacion/v1/personas/CE/123456"), all_operations)
	h["X-DEN-Subject-Ref"] == subject_ref_of("CE", "123456")
}

test_the_document_type_is_written_as_the_country_names_it if {
	denied(get_path("/salud/afiliacion/v1/personas/ce/123456"), all_operations, "data_subject_invalid")
}

test_an_unknown_document_type_is_denied if {
	denied(get_path("/salud/afiliacion/v1/personas/xx/123456"), all_operations, "data_subject_invalid")
}

test_a_malformed_number_is_denied if {
	denied(get_path("/salud/afiliacion/v1/afiliados/12"), bundle, "data_subject_invalid")
	denied(get_path("/salud/afiliacion/v1/afiliados/1000%2F0001"), bundle, "data_subject_invalid")
}

test_a_type_without_a_format_keeps_to_the_shape if {
	h := headers_for(get_path("/salud/afiliacion/v1/personas/TI/0012345"), all_operations)
	h["X-DEN-Subject-Ref"] == subject_ref_of("TI", "0012345")
	denied(get_path("/salud/afiliacion/v1/personas/TI/ab12345"), all_operations, "data_subject_invalid")
}

test_without_formats_in_the_bundle_every_type_keeps_to_the_shape if {
	h := authz.headers with input as get_path("/salud/afiliacion/v1/afiliados/01000000001")
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as object.remove(bundle.config, ["documentNumberFormats"])
		with time.now_ns as june_2026
	h["X-DEN-Subject-Ref"] == subject_ref_of("CC", "01000000001")
}

test_the_body_subject_read_by_the_gateway_becomes_a_reference if {
	h := headers_for(post_verification({"x-den-body-subject": "CC:1000000001"}), all_operations)
	h["X-DEN-Subject-Ref"] == subject_ref_of("CC", "1000000001")
	not h["X-DEN-Body-Subject"]
	not h["x-den-body-subject"]
}

test_a_bare_number_uses_the_operation_document_type if {
	h := headers_for(post_verification({"x-den-body-subject": "1000000001"}), all_operations)
	h["X-DEN-Subject-Ref"] == subject_ref_of("CC", "1000000001")
}

test_a_body_subject_in_another_spelling_is_denied if {
	every value in [" 1000000001 ", "01000000001", "CC:1.000.000.001", "cc:1000000001", " CC:1000000001"] {
		denied(post_verification({"x-den-body-subject": value}), all_operations, "data_subject_invalid")
	}
}

test_an_operation_with_a_body_subject_requires_it if {
	denied(post_verification({}), all_operations, "data_subject_required")
	denied(post_verification({"x-den-body-subject": ["CC:1000000001", "CC:1000000002"]}), all_operations, "data_subject_required")
	denied(post_verification({"x-den-body-subject": "CC:1000:0001"}), all_operations, "data_subject_required")
	denied(post_verification({"x-den-body-subject": "XX:1000000001"}), all_operations, "data_subject_invalid")
}

test_operations_without_a_subject_carry_no_reference if {
	none := headers_for(get_path("/salud/afiliacion/v1/estadisticas"), all_operations)
	none["X-DEN-Subscription"] == "sub-1"
	not none["X-DEN-Subject-Ref"]
}

test_personal_data_without_a_valid_declaration_fails_closed if {
	# A stale version (no declaration, or one no longer accepted) cannot say whose data it is.
	denied(get_path("/salud/afiliacion/v1/legado"), all_operations, "data_subject_required")
	denied(get_path("/salud/afiliacion/v1/legado"), sensitive_route(all_operations), "data_subject_required")
}

test_public_data_without_a_declaration_is_allowed if {
	h := headers_for(get_path("/salud/afiliacion/v1/legado"), public_route(all_operations))
	h["X-DEN-Subscription"] == "sub-1"
	not h["X-DEN-Subject-Ref"]
}

with_classification(b, classification) := object.union(b, {"routes": {route_id: object.union(b.routes[route_id], {"classification": classification})}})

sensitive_route(b) := with_classification(b, "sensitive")

public_route(b) := with_classification(b, "public")

test_a_denial_never_carries_the_reference if {
	h := headers_for(with_headers({"x-den-purpose": "benefit_targeting"}), bundle)
	not h["X-DEN-Subject-Ref"]
}

test_the_consumer_cannot_assert_the_subject_in_a_header if {
	# Only the gateway plugin sets x-den-body-subject; the old consumer header is ignored.
	denied(post_verification({"x-den-data-subject": "CC:1000000001"}), all_operations, "data_subject_required")
}

# --- Rule 6: deny response ------------------------------------------------------------------

test_a_denial_of_an_unknown_client_names_no_consumer if {
	inp := with_headers({"authorization": concat(" ", ["Bearer", token({"azp": "den-app-unknown"})])})
	h := headers_for(inp, bundle)
	h["X-DEN-Deny-Reason"] == "no_subscription"
	not h["X-DEN-Consumer-App"]
	not h["X-DEN-Consumer-Entity"]
}

test_deny_returns_problem_json_and_the_reason_header if {
	inp := with_headers({"x-den-purpose": "benefit_targeting"})
	h := authz.headers with input as inp
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
	h == {
		"Content-Type": "application/problem+json",
		"X-DEN-Deny-Reason": "purpose_not_allowed",
		# The known client is named for the access log (M5-03).
		"X-DEN-Consumer-App": "den-app-a",
		"X-DEN-Consumer-Entity": "programas-sociales",
	}
	body := authz.reason with input as inp
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
	body.code == "purpose_not_allowed"
	body.status == 403
	body.type == "https://den.example/errors/purpose_not_allowed"
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

# --- Client certificate (SPIKE S-3, M3-02) ----------------------------------------------------

mtls_bundle := object.union(bundle, {"config": {"mtlsRequired": true}})

bound_token(thumbprint) := concat(" ", ["Bearer", token({"azp": "den-app-a", "cnf": {"x5t#S256": thumbprint}})])

mtls_call(thumbprint, bound) := with_headers({
	"authorization": bound_token(bound),
	"x-den-client-cert-s256": thumbprint,
})

test_mtls_allows_the_bound_certificate_of_the_application if {
	authz.allow with input as mtls_call("thumb-a", "thumb-a")
		with data.routes as mtls_bundle.routes
		with data.clients as mtls_bundle.clients
		with data.config as mtls_bundle.config
		with time.now_ns as june_2026
}

test_mtls_never_forwards_the_thumbprint if {
	h := headers_for(mtls_call("thumb-a", "thumb-a"), mtls_bundle)
	h["X-DEN-Subscription"] == "sub-1"
	not h["X-DEN-Client-Cert-S256"]
}

test_mtls_requires_a_verified_certificate if {
	inp := with_headers({"authorization": bound_token("thumb-a")})
	denied(inp, mtls_bundle, "client_certificate_required")
}

test_mtls_requires_a_bound_token if {
	denied(with_headers({"x-den-client-cert-s256": "thumb-a"}), mtls_bundle, "token_not_bound")
}

test_mtls_denies_a_token_bound_to_another_certificate if {
	denied(mtls_call("thumb-a", "thumb-b"), mtls_bundle, "certificate_mismatch")
}

test_mtls_denies_a_certificate_no_longer_valid_for_the_application if {
	revoked := json.patch(mtls_bundle, [{"op": "replace", "path": "/clients/den-app-a/certificates", "value": []}])
	denied(mtls_call("thumb-a", "thumb-a"), revoked, "certificate_revoked")
}

test_mtls_denies_the_certificate_of_another_application if {
	other := json.patch(mtls_bundle, [{"op": "add", "path": "/clients/den-app-b", "value": object.union(
		bundle.clients["den-app-a"],
		{"applicationId": "b", "certificates": ["thumb-b"]},
	)}])
	denied(mtls_call("thumb-b", "thumb-b"), other, "certificate_revoked")
}

test_mtls_denies_a_repeated_thumbprint_header if {
	inp := with_headers({"authorization": bound_token("thumb-a"), "x-den-client-cert-s256": ["thumb-a", "thumb-a"]})
	denied(inp, mtls_bundle, "client_certificate_required")
}

test_mtls_reports_a_suspended_application_first if {
	suspended := object.union(mtls_bundle, {"clients": {"den-app-a": {"status": "suspended"}}})
	denied(with_headers({}), suspended, "app_suspended")
}

test_without_mtls_an_unbound_call_needs_no_certificate if {
	authz.allow with input as request({})
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
}

test_without_mtls_a_bound_token_still_needs_its_certificate if {
	denied(with_headers({"authorization": bound_token("thumb-a")}), bundle, "client_certificate_required")
	denied(mtls_call("thumb-b", "thumb-a"), bundle, "certificate_mismatch")
	authz.allow with input as mtls_call("thumb-a", "thumb-a")
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
}

test_mtls_deny_reason_has_a_problem_detail if {
	r := authz.reason with input as with_headers({"authorization": bound_token("thumb-a")})
		with data.routes as mtls_bundle.routes
		with data.clients as mtls_bundle.clients
		with data.config as mtls_bundle.config
		with time.now_ns as june_2026
	r.code == "client_certificate_required"
	r.status == 403
	contains(r.detail, "client certificate")
}

# --- Per-subscription limit (SPIKE S-2, ADR-0020, M3-05) --------------------------------------

test_allow_passes_the_subscription_limit_for_limit_count if {
	h := headers_for(request({}), bundle)
	h["X-DEN-Rate-Limit"] == "600"
	h["X-DEN-Subscription"] == "sub-1"
}

test_the_limit_is_shared_among_gateway_nodes_rounding_up if {
	three_nodes := object.union(bundle, {"config": {"gatewayNodes": 3}})
	h := headers_for(request({}), three_nodes)
	h["X-DEN-Rate-Limit"] == "200"
	odd := object.union(with_subscription({"rateLimitPerMinute": 10}), {"config": {"gatewayNodes": 3}})
	headers_for(request({}), odd)["X-DEN-Rate-Limit"] == "4"
}

test_a_client_cannot_choose_its_limit if {
	h := headers_for(with_headers({"x-den-rate-limit": "1000000"}), bundle)
	h["X-DEN-Rate-Limit"] == "600"
}

test_a_denied_call_carries_no_limit if {
	inp := with_headers({"x-den-purpose": "other_purpose"})
	h := headers_for(inp, bundle)
	not h["X-DEN-Rate-Limit"]
}

test_without_gateway_nodes_one_node_is_assumed if {
	no_nodes := json.patch(bundle, [{"op": "remove", "path": "/config/gatewayNodes"}])
	headers_for(request({}), no_nodes)["X-DEN-Rate-Limit"] == "600"
}

# --- Official behind the call (M3-06) ----------------------------------------------------------

test_the_classification_requires_the_official_even_if_the_subscription_did_not if {
	b := with_subscription({"endUserRequired": false})
	denied(without_header("x-den-end-user"), b, "end_user_required")
	sensitive := json.patch(b, [{"op": "replace", "path": "/routes/den-route-v1/classification", "value": "sensitive"}])
	denied(without_header("x-den-end-user"), sensitive, "end_user_required")
}

test_an_internal_api_without_the_flag_needs_no_official if {
	internal := json.patch(with_subscription({"endUserRequired": false}), [{"op": "replace", "path": "/routes/den-route-v1/classification", "value": "internal"}])
	authz.allow with input as without_header("x-den-end-user")
		with data.routes as internal.routes
		with data.clients as internal.clients
		with data.config as internal.config
		with time.now_ns as june_2026
}

test_an_official_that_is_not_an_identifier_is_refused if {
	denied(with_headers({"x-den-end-user": "Juan Pérez"}), bundle, "end_user_invalid")
	denied(with_headers({"x-den-end-user": concat("", [x | some _ in numbers.range(1, 129); x := "a"])}), bundle, "end_user_invalid")
	denied(with_headers({"x-den-end-user": "ab\tcd"}), bundle, "end_user_invalid")
}

test_an_invalid_official_is_refused_even_where_not_required if {
	internal := json.patch(with_subscription({"endUserRequired": false}), [{"op": "replace", "path": "/routes/den-route-v1/classification", "value": "internal"}])
	denied(with_headers({"x-den-end-user": "dos palabras"}), internal, "end_user_invalid")
}

test_the_official_is_hashed_with_the_deployment_salt_and_never_forwarded if {
	h := headers_for(with_headers({"x-den-end-user": "funcionario@entidad.example"}), bundle)
	h["X-DEN-End-User-Hash"] == crypto.hmac.sha256("funcionario@entidad.example", "test-salt")
	other_salt := object.union(bundle, {"config": {"endUserHashSalt": "another-deployment-salt"}})
	h2 := headers_for(with_headers({"x-den-end-user": "funcionario@entidad.example"}), other_salt)
	h2["X-DEN-End-User-Hash"] != h["X-DEN-End-User-Hash"]
	not h["X-DEN-End-User"]
	not h2["X-DEN-End-User"]
}

test_the_longest_valid_official_is_accepted if {
	long := concat("", [x | some _ in numbers.range(1, 128); x := "a"])
	h := headers_for(with_headers({"x-den-end-user": long}), bundle)
	h["X-DEN-End-User-Hash"] == crypto.hmac.sha256(long, "test-salt")
}

# --- X-Road routes (M4-05, SPIKE S-5) -----------------------------------------------------------

xroad_bundle := json.patch(bundle, [{"op": "add", "path": "/routes/den-route-v1/xroad", "value": true}])

test_xroad_routes_carry_the_official_hash_and_the_subscription if {
	h := authz.headers with input as request({})
		with data.routes as xroad_bundle.routes
		with data.clients as xroad_bundle.clients
		with data.config as xroad_bundle.config
		with time.now_ns as june_2026
	h["X-Road-UserId"] == crypto.hmac.sha256("funcionario-42", "test-salt")
	h["X-Road-Issue"] == "den:subscription:sub-1"
	h["X-DEN-Subscription"] == "sub-1"
}

test_xroad_without_an_official_carries_only_the_subscription if {
	b := json.patch(xroad_bundle, [
		{"op": "replace", "path": "/routes/den-route-v1/classification", "value": "internal"},
		{"op": "replace", "path": "/clients/den-app-a/subscriptions/0/endUserRequired", "value": false},
	])
	h := authz.headers with input as without_header("x-den-end-user")
		with data.routes as b.routes
		with data.clients as b.clients
		with data.config as b.config
		with time.now_ns as june_2026
	h["X-Road-Issue"] == "den:subscription:sub-1"
	not h["X-Road-UserId"]
}

test_other_routes_never_carry_x_road_headers if {
	h := authz.headers with input as request({})
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
	not h["X-Road-UserId"]
	not h["X-Road-Issue"]
}

# --- Sandbox (M4-08) ----------------------------------------------------------------------------

test_a_sandbox_app_never_reaches_a_production_route if {
	b := json.patch(bundle, [{"op": "add", "path": "/clients/den-app-a/environment", "value": "sandbox"}])
	denied(request({}), b, "environment_mismatch")
}

test_a_production_app_never_reaches_a_sandbox_route if {
	b := json.patch(bundle, [{"op": "add", "path": "/routes/den-route-v1/sandbox", "value": true}])
	denied(request({}), b, "environment_mismatch")
}

test_a_sandbox_app_reaches_its_sandbox_route if {
	b := json.patch(bundle, [
		{"op": "add", "path": "/clients/den-app-a/environment", "value": "sandbox"},
		{"op": "add", "path": "/routes/den-route-v1/sandbox", "value": true},
	])
	authz.allow with input as request({})
		with data.routes as b.routes
		with data.clients as b.clients
		with data.config as b.config
		with time.now_ns as june_2026
}

# --- What the gateway reads (M6-03) --------------------------------------------------------------

test_decision_is_what_the_gateway_reads_of_an_allowed_call if {
	d := authz.decision with input as request({})
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
	h := authz.headers with input as request({})
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
	d == {"allow": true, "headers": h}
}

test_decision_is_what_the_gateway_reads_of_a_denied_call if {
	d := authz.decision with input as without_header("authorization")
		with data.routes as bundle.routes
		with data.clients as bundle.clients
		with data.config as bundle.config
		with time.now_ns as june_2026
	object.keys(d) == {"allow", "headers", "status_code", "reason"}
	d.allow == false
	d.status_code == 403
	d.reason.code == "no_subscription"
	d.headers["X-DEN-Deny-Reason"] == "no_subscription"
}

