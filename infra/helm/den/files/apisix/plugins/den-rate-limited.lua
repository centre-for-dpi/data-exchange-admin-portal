--
-- rid-rate-limited: the gateway's own 429 in RFC 9457 problem+json (SPIKE S-2, M3-05).
--
-- limit-count rejects a call over its subscription's limit with 429 before any upstream is
-- contacted, so $upstream_status is empty. Only that 429 gets the problem+json body (code
-- rate_limited); a 429 the provider sends keeps its own body. The X-RateLimit-* headers of
-- limit-count stay: they tell the consumer the limit, what is left and when it resets.
--
-- response-rewrite could do it with a condition, but a route has a single response-rewrite and
-- deprecated versions already use it for their Deprecation and Sunset headers (ADR-0019).
--
local core = require("apisix.core")

local PROBLEM = core.json.encode({
    type = "https://rid.example/errors/rate_limited",
    title = "Too many requests",
    status = 429,
    code = "rate_limited",
    detail = "The subscription reached its limit of requests per minute. "
        .. "Retry after the seconds in X-RateLimit-Reset.",
})

local schema = {
    type = "object",
    properties = {},
    additionalProperties = false,
}

local _M = {
    version = 0.1,
    priority = 898,
    name = "rid-rate-limited",
    schema = schema,
}

function _M.check_schema(conf)
    return core.schema.check(schema, conf)
end

function _M.header_filter(_conf, ctx)
    if ngx.status ~= 429 then
        return
    end
    local upstream_status = ngx.var.upstream_status
    if upstream_status ~= nil and upstream_status ~= "" then
        return
    end
    ctx.rid_rate_limited = true
    core.response.set_header("Content-Type", "application/problem+json")
    -- A refusal of the gateway, like OPA's: the access log counts it with its reason (M5-03).
    core.response.set_header("X-RID-Deny-Reason", "rate_limited")
    core.response.clear_header_as_body_modified()
end

function _M.body_filter(_conf, ctx)
    if not ctx.rid_rate_limited then
        return
    end
    if ngx.arg[2] then
        ngx.arg[1] = PROBLEM
    else
        ngx.arg[1] = ""
    end
end

return _M
