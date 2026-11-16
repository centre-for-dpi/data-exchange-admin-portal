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
-- On the way back (M5-01) a provider never chooses an X-RID-* response header either: the
-- access log reads the deny reason and the consumer of a denial from them, and the consumer
-- trusts them. Only a response the gateway produced itself (OPA's denial, no upstream contacted)
-- keeps the ones its plugins set. ngx.header turns "_" into "-", so a name spelled with
-- underscores (X_RID_Deny_Reason) cannot be removed here; it is not an X-RID-* header to the
-- consumer, and the access-log filter ignores a deny reason when an upstream answered.
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

-- APISIX accepts underscores in header names, and CGI-style servers (WSGI, PHP, Rack...) read
-- X_RID_Subscription and X-RID-Subscription as the same HTTP_X_RID_SUBSCRIPTION: underscores
-- count as hyphens here.
local function rid_header(name)
    local lower = string.lower(name)
    local normalized = string.gsub(lower, "_", "-")
    return string.sub(normalized, 1, 6) == "x-rid-", lower, normalized
end

function _M.rewrite(_conf, ctx)
    local headers = ngx.req.get_headers(0, true)
    for name in pairs(headers) do
        -- Only the hyphenated consumer headers stay.
        local rid, lower, normalized = rid_header(name)
        if rid and not (lower == normalized and CONSUMER_DECLARED[lower]) then
            core.request.set_header(ctx, name, nil)
        end
    end
end

function _M.header_filter(_conf, _ctx)
    -- Set by nginx once it proxied to an upstream; empty when a plugin answered on its own.
    local upstream = ngx.var.upstream_status
    if upstream == nil or upstream == "" then
        return
    end
    for name in pairs(ngx.resp.get_headers(0, true)) do
        if rid_header(name) then
            ngx.header[name] = nil
        end
    end
end

return _M
