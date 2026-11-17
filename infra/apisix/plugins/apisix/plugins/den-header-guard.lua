--
-- den-header-guard: a client never chooses an X-DEN-* header the gateway or OPA sets (M3-07).
--
-- First thing in the rewrite phase, before any plugin reads or sets one, it removes every
-- request header whose name starts with X-DEN- except the ones the consumer declares itself:
-- X-DEN-Purpose (the purpose of the call) and X-DEN-End-User (the official, which OPA turns into a
-- salted hash and never forwards). The trace headers the provider receives (X-DEN-Consumer-*,
-- X-DEN-Subscription, X-DEN-Operation, X-DEN-End-User-Hash, X-DEN-Subject-Ref, X-DEN-Rate-Limit)
-- are then only ever the ones OPA returns, and the inputs other gateway plugins compute
-- (X-DEN-Body-Subject, X-DEN-Client-Cert-S256) only theirs. A header added to the network later
-- is protected without changing this list.
--
-- Priority 2700: before openid-connect (2599), den-client-cert (1025), den-data-subject (1020)
-- and proxy-rewrite (1008), in the rewrite phase; opa runs later, in access.
--
-- On the way back (M5-01) a provider never chooses an X-DEN-* response header either: the
-- access log reads the deny reason and the consumer of a denial from them, and the consumer
-- trusts them. Only a response the gateway produced itself (OPA's denial, no upstream contacted)
-- keeps the ones its plugins set. ngx.header turns "_" into "-", so a name spelled with
-- underscores (X_DEN_Deny_Reason) cannot be removed here; it is not an X-DEN-* header to the
-- consumer, and the access-log filter ignores a deny reason when an upstream answered.
--
local core = require("apisix.core")

local CONSUMER_DECLARED = {
    ["x-den-purpose"] = true,
    ["x-den-end-user"] = true,
}

local schema = {
    type = "object",
    properties = {},
    additionalProperties = false,
}

local _M = {
    version = 0.1,
    priority = 2700,
    name = "den-header-guard",
    schema = schema,
}

function _M.check_schema(conf)
    return core.schema.check(schema, conf)
end

-- APISIX accepts underscores in header names, and CGI-style servers (WSGI, PHP, Rack...) read
-- X_DEN_Subscription and X-DEN-Subscription as the same HTTP_X_DEN_SUBSCRIPTION: underscores
-- count as hyphens here.
local function den_header(name)
    local lower = string.lower(name)
    local normalized = string.gsub(lower, "_", "-")
    return string.sub(normalized, 1, 6) == "x-den-", lower, normalized
end

function _M.rewrite(_conf, ctx)
    local headers = ngx.req.get_headers(0, true)
    for name in pairs(headers) do
        -- Only the hyphenated consumer headers stay.
        local den, lower, normalized = den_header(name)
        if den and not (lower == normalized and CONSUMER_DECLARED[lower]) then
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
        if den_header(name) then
            ngx.header[name] = nil
        end
    end
end

return _M
