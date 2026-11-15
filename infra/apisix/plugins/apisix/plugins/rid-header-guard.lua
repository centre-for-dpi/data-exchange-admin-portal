--
-- rid-header-guard: a client never chooses an X-RID-* header the gateway or OPA sets (M3-07).
--
-- First thing in the rewrite phase, before any plugin reads or sets one, it removes every
-- request header whose name starts with X-RID- except the ones the consumer declares itself:
-- X-RID-Purpose (the purpose of the call) and X-RID-End-User (the official, which OPA turns into a
-- salted hash and never forwards). The trace headers the provider receives (X-RID-Consumer-*,
-- X-RID-Subscription, X-RID-Operation, X-RID-End-User-Hash, X-RID-Subject-Ref, X-RID-Rate-Limit)
-- are then only ever the ones OPA returns, and the inputs other gateway plugins compute
-- (X-RID-Body-Subject, X-RID-Client-Cert-S256) only theirs. A header added to the network later
-- is protected without changing this list.
--
-- Priority 2700: before openid-connect (2599), rid-client-cert (1025), rid-data-subject (1020)
-- and proxy-rewrite (1008), in the rewrite phase; opa runs later, in access.
--
local core = require("apisix.core")

local CONSUMER_DECLARED = {
    ["x-rid-purpose"] = true,
    ["x-rid-end-user"] = true,
}

local schema = {
    type = "object",
    properties = {},
    additionalProperties = false,
}

local _M = {
    version = 0.1,
    priority = 2700,
    name = "rid-header-guard",
    schema = schema,
}

function _M.check_schema(conf)
    return core.schema.check(schema, conf)
end

function _M.rewrite(_conf, ctx)
    local headers = ngx.req.get_headers(0, true)
    for name in pairs(headers) do
        -- APISIX accepts underscores in header names, and CGI-style servers (WSGI, PHP, Rack...)
        -- read X_RID_Subscription and X-RID-Subscription as the same HTTP_X_RID_SUBSCRIPTION:
        -- underscores count as hyphens here, and only the hyphenated consumer headers stay.
        local lower = string.lower(name)
        local normalized = string.gsub(lower, "_", "-")
        if string.sub(normalized, 1, 6) == "x-rid-"
            and not (lower == normalized and CONSUMER_DECLARED[lower]) then
            core.request.set_header(ctx, name, nil)
        end
    end
end

return _M
