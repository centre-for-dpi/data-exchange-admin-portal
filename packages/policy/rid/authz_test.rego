package rid.authz_test

import rego.v1

import data.rid.authz

test_denies_by_default if {
	not authz.allow with input as {}
}

test_default_reason_is_no_subscription if {
	authz.result.reason == "no_subscription" with input as {}
}
