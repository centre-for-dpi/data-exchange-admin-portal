# Traffic authorization policy evaluated by APISIX's opa plugin (ARCHITECTURE.md §4.2).
#
# APISIX queries data.rid.authz and reads `allow`, `headers`, `status_code` and `reason`:
# - allow: `headers` go to the upstream. Every header listed in the plugin's
#   send_headers_upstream that this policy does NOT return is removed, so client values never
#   pass through unchecked (SPIKE S-1). X-RID-End-User is never returned: only its salted hash.
# - deny: `headers` are response headers (problem+json and X-RID-Deny-Reason for the access log)
#   and `reason` is the problem+json body.
#
# The data comes from the portal's bundle: data.routes, data.clients and data.config.
package rid.authz

import rego.v1

# --- Request ------------------------------------------------------------------------------

# Only single-valued headers count: a repeated header (an array) is treated as absent.
header(name) := value if {
	value := input.request.headers[name]
	is_string(value)
}

bearer := token if {
	parts := split(header("authorization"), " ")
	count(parts) == 2
	lower(parts[0]) == "bearer"
	token := parts[1]
}

# Rule 1: the JWT was validated by openid-connect (signature, issuer, aud); OPA only decodes it.
claims := payload if {
	[_, payload, _] := io.jwt.decode(bearer)
}

client_id := claims.azp

client_id := claims.client_id if not claims.azp

client := data.clients[client_id]

route_id := input.route.id

route := data.routes[route_id]

purpose := header("x-rid-purpose")

end_user := header("x-rid-end-user")

# Rule 3: the operation is found by method and by pathRegex on the full public path.
operation := op if {
	some op in route.operations
	op.method == input.request.method
	regex.match(op.pathRegex, input.request.path)
}

now := time.now_ns()

# --- Subscriptions (rule 4) -----------------------------------------------------------------

route_subscriptions contains s if {
	some s in client.subscriptions
	s.route == route_id
}

with_operation contains s if {
	some s in route_subscriptions
	operation.id in s.operations
}

with_purpose contains s if {
	some s in with_operation
	purpose in s.purposes
}

current contains s if {
	some s in with_purpose
	time.parse_rfc3339_ns(s.validFrom) <= now
	now < time.parse_rfc3339_ns(s.validUntil)
}

# Deterministic choice when (unusually) more than one subscription matches.
subscription := sort([s.id | some s in current])[0]

subscription_data := s if {
	some s in current
	s.id == subscription
}

# Rule 5: personal data needs the official behind the call.
end_user_missing if {
	subscription_data.endUserRequired
	not end_user
}

# --- Data subject (ADR-0015) ----------------------------------------------------------------
#
# The operation says where its data subject is (bundle `subject`, from x-rid-data-subject). The
# policy turns it into a keyed pseudonym; the document number itself never leaves the request.

declares_subject if operation.subject.in in {"path", "body"}

# Fail closed: personal or sensitive data without a valid declaration (absent, or a form no longer
# accepted, such as the old consumer header) cannot say whose data it is, so it is denied. The lint
# requires the declaration for these classifications, so only stale versions get here.
declares_subject if {
	route.classification in {"personal", "sensitive"}
	not operation.subject
}

# Document numbers are compared without spaces, dots or hyphens, in upper case.
normalized(value) := upper(replace(replace(replace(trim_space(value), " ", ""), ".", ""), "-", ""))

default_document_type := object.get(operation.subject, "documentType", data.config.documentTypes[0])

path_match := regex.find_all_string_submatch_n(operation.subject.regex, input.request.path, 1)[0] if {
	operation.subject.in == "path"
}

subject_type := upper(path_match[operation.subject.typeGroup]) if {
	operation.subject.typeGroup
} else := default_document_type if {
	operation.subject.in == "path"
}

subject_number := normalized(path_match[operation.subject.numberGroup])

# Body subjects: the gateway plugin rid-data-subject read them from the JSON body (ADR-0017) and
# passes "TYPE:NUMBER", or just "NUMBER" with the operation's (or the country's) type. Any value
# the client sent in that header was removed before; the consumer cannot assert the subject.
header_parts := split(header("x-rid-body-subject"), ":") if operation.subject.in == "body"

subject_type := upper(trim_space(header_parts[0])) if count(header_parts) == 2

subject_type := default_document_type if count(header_parts) == 1

subject_number := normalized(header_parts[1]) if count(header_parts) == 2

subject_number := normalized(header_parts[0]) if count(header_parts) == 1

subject_ref := crypto.hmac.sha256(
	concat("|", [data.config.country, subject_type, subject_number]),
	data.config.subjectRefKey,
) if {
	subject_type in data.config.documentTypes
	regex.match(`^[A-Z0-9]{3,20}$`, subject_number)
}

# --- Decision -------------------------------------------------------------------------------

# The first failing check names the reason (stable codes, ARCHITECTURE.md §4.2).
deny_reason := "no_subscription" if {
	not client
} else := "app_suspended" if {
	client.status != "active"
} else := "no_subscription" if {
	not route
} else := "operation_not_allowed" if {
	not operation
} else := "no_subscription" if {
	count(route_subscriptions) == 0
} else := "operation_not_allowed" if {
	count(with_operation) == 0
} else := "purpose_not_allowed" if {
	count(with_purpose) == 0
} else := "subscription_expired" if {
	count(current) == 0
} else := "end_user_required" if {
	end_user_missing
} else := "data_subject_required" if {
	declares_subject
	not subject_ref
}

default allow := false

allow if not deny_reason

# Rule 6, allow: headers for the upstream.
end_user_hash := crypto.hmac.sha256(end_user, data.config.endUserHashSalt) if end_user

base_headers := {
	"X-RID-Consumer-Entity": client.entitySlug,
	"X-RID-Consumer-App": client_id,
	"X-RID-Subscription": subscription,
	"X-RID-Purpose": purpose,
	"X-RID-Operation": operation.id,
	"X-Request-Id": object.get(input.request.headers, "x-request-id", ""),
}

end_user_header := {"X-RID-End-User-Hash": end_user_hash} if end_user_hash

else := {}

subject_header := {"X-RID-Subject-Ref": subject_ref} if subject_ref

else := {}

# X-RID-End-User and X-RID-Body-Subject are never returned: the opa plugin then removes the
# clear values the client sent (SPIKE S-1).
headers := object.union_n([base_headers, end_user_header, subject_header]) if allow

# Rule 6, deny: response headers and a problem+json body.
headers := {
	"Content-Type": "application/problem+json",
	"X-RID-Deny-Reason": deny_reason,
} if not allow

status_code := 403 if not allow

reason := {
	"type": sprintf("https://rid.example/errors/%s", [deny_reason]),
	"title": "Access denied by the data exchange network",
	"status": 403,
	"code": deny_reason,
	"detail": details[deny_reason],
} if not allow

details := {
	"no_subscription": "The application has no subscription to this API version.",
	"app_suspended": "The application is suspended.",
	"operation_not_allowed": "The subscription does not cover this operation.",
	"purpose_not_allowed": "Send X-RID-Purpose with a purpose approved for this subscription.",
	"subscription_expired": "The subscription is not valid at this time.",
	"end_user_required": "This API requires X-RID-End-User with the official making the request.",
	"data_subject_required": "The request does not say whose data it asks for, in the path or in the body as the API documents.",
}
