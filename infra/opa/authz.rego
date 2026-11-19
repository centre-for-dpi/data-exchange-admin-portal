# Who may use OPA's API (B-15, ADR-0031). OPA runs with --authentication=token
# --authorization=basic and evaluates this policy on every request to its API; anything it does not
# allow is a 401. Loaded from this file, outside the bundle's roots: the bundle cannot change it.
#
# - The gateway: only decisions, the rules named `decision` (den/authz/decision), with the decision
#   token (DEN_OPA_DECISION_TOKEN) in the den_token query parameter. The opa plugin of APISIX 3.19
#   sends no header of its own; OPA's log records the path without the query.
# - The operator and the tests: the whole API, with the admin token (DEN_OPA_ADMIN_TOKEN) as a
#   bearer token. Reading data.config (the pseudonym key, the official's salt) or replacing a
#   policy needs it.
# - Health and metrics carry no data and stay open: the container's health check and Prometheus.
package system.authz

import rego.v1

default allow := false

allow if {
	input.method == "GET"
	input.path in [["health"], ["metrics"]]
}

allow if {
	input.method == "POST"
	count(input.path) > 2
	array.slice(input.path, 0, 2) == ["v1", "data"]
	input.path[count(input.path) - 1] == "decision"
	same(input.params.den_token[0], opa.runtime().env.DEN_OPA_DECISION_TOKEN)
}

allow if same(input.identity, opa.runtime().env.DEN_OPA_ADMIN_TOKEN)

# Tokens of at least 32 characters, compared through their hashes.
same(given, expected) if {
	count(expected) >= 32
	crypto.sha256(given) == crypto.sha256(expected)
}
