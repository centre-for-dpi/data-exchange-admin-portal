# Traffic authorization policy evaluated by APISIX's opa plugin.
# Rules 1-6 of ARCHITECTURE.md §4.2 are implemented in M1-09; until then everything is denied.
package rid.authz

import rego.v1

default allow := false

default reason := "no_subscription"

result := {
	"allow": allow,
	"reason": reason,
}
