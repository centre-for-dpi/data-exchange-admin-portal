--
-- den-data-subject: reads the data subject of a call from its JSON body (ADR-0017).
--
-- For operations whose OpenAPI declares x-den-data-subject { in: body, pointer }, this plugin
-- reads the request body (in memory, bounded), resolves the JSON pointer and passes the value to
-- OPA in X-DEN-Body-Subject ("TYPE:NUMBER" or "NUMBER"). OPA turns it into X-DEN-Subject-Ref and
-- never returns X-DEN-Body-Subject, so the value is removed before the upstream (SPIKE S-1).
--
-- A client cannot assert the subject: any X-DEN-Body-Subject it sends is removed first. The gateway
-- and the provider must read the same person, so the plugin gives no subject (OPA then denies) when
-- the body is not declared as JSON, repeats a member name (I-JSON, RFC 7493) or the value has a
-- colon. The body
-- is never stored or logged (golden rule 2). Runs in the rewrite phase after openid-connect
-- (2599), so unauthenticated calls are rejected before any body is read, and before
-- proxy-rewrite (1008) and opa (access phase).
--
local core = require("apisix.core")
local cjson = require("cjson.safe")
local ngx_re = require("ngx.re")

local HEADER = "X-DEN-Body-Subject"

local schema = {
    type = "object",
    properties = {
        -- Largest body the plugin reads; bigger bodies get no subject (OPA then denies).
        max_body_bytes = { type = "integer", minimum = 1, maximum = 1048576, default = 65536 },
        operations = {
            type = "array",
            minItems = 1,
            items = {
                type = "object",
                properties = {
                    method = { type = "string", minLength = 1 },
                    -- Anchored regex on the full public path (same as the OPA bundle).
                    uri = { type = "string", minLength = 1 },
                    pointer = { type = "string", pattern = "^(/([^~/]|~[01])*)+$" },
                    type_pointer = { type = "string", pattern = "^(/([^~/]|~[01])*)+$" },
                },
                required = { "method", "uri", "pointer" },
                additionalProperties = false,
            },
        },
    },
    required = { "operations" },
    additionalProperties = false,
}

local _M = {
    version = 0.1,
    priority = 1020,
    name = "den-data-subject",
    schema = schema,
}

function _M.check_schema(conf)
    return core.schema.check(schema, conf)
end

-- RFC 6901 JSON pointer over decoded JSON (arrays are 0-based in the pointer).
local function resolve(document, pointer)
    local value = document
    local tokens = ngx_re.split(pointer:sub(2), "/")
    for _, token in ipairs(tokens) do
        token = token:gsub("~1", "/"):gsub("~0", "~")
        if type(value) ~= "table" then
            return nil
        end
        local index = tonumber(token)
        if index and value[index + 1] ~= nil then
            value = value[index + 1]
        else
            value = value[token]
        end
        if value == nil then
            return nil
        end
    end
    return value
end

-- Only strings and whole numbers identify a person; anything else is no subject.
local function as_text(value)
    if type(value) == "string" then
        return value
    end
    if type(value) == "number" and value == math.floor(value) and value >= 0 then
        return string.format("%.0f", value)
    end
    return nil
end

-- application/json or any +json media type.
local function is_json(content_type)
    return content_type ~= nil
        and ngx.re.find(content_type, [[^\s*application/([a-z0-9.+-]*\+)?json\s*(;|$)]], "joi") ~= nil
end

-- True when some object in a (valid) JSON text repeats a member name. Parsers disagree on which
-- value wins, so the gateway and the provider could read different people.
local function has_duplicate_names(body)
    local stack = {}
    local i = 1
    while true do
        local at, _, char = body:find('(["{}%[%],])', i)
        if not at then
            return false
        end
        local top = stack[#stack]
        if char == "{" then
            stack[#stack + 1] = { object = true, names = {}, expect_name = true }
        elseif char == "[" then
            stack[#stack + 1] = { object = false }
        elseif char == "}" or char == "]" then
            stack[#stack] = nil
        elseif char == "," then
            if top and top.object then
                top.expect_name = true
            end
        else
            -- A string: find its closing quote, skipping escapes.
            local j = at + 1
            while true do
                local k, _, c = body:find('(["\\])', j)
                if not k then
                    return false
                end
                if c == "\\" then
                    j = k + 2
                else
                    j = k
                    break
                end
            end
            if top and top.object and top.expect_name then
                local name = cjson.decode(body:sub(at, j))
                if name == nil or top.names[name] then
                    return true
                end
                top.names[name] = true
                top.expect_name = false
            end
            at = j
        end
        i = at + 1
    end
end

function _M.rewrite(conf, ctx)
    -- Never trust a value the client sent.
    core.request.set_header(ctx, HEADER, nil)

    local method = core.request.get_method()
    local uri = ctx.var.uri
    local operation
    for _, op in ipairs(conf.operations) do
        if op.method == method and ngx.re.find(uri, op.uri, "jo") then
            operation = op
            break
        end
    end
    if not operation then
        return
    end

    if not is_json(core.request.header(ctx, "Content-Type")) then
        return
    end
    local body = core.request.get_body(conf.max_body_bytes, ctx)
    if not body then
        return
    end
    local document = cjson.decode(body)
    if type(document) ~= "table" or has_duplicate_names(body) then
        return
    end

    local number = as_text(resolve(document, operation.pointer))
    if not number or number:find(":", 1, true) then
        return
    end
    local document_type
    if operation.type_pointer then
        document_type = as_text(resolve(document, operation.type_pointer))
        -- A declared type that is missing or malformed is no subject (OPA denies).
        if not document_type or document_type:find(":", 1, true) then
            return
        end
    end
    -- Colons separate type and number; neither may contain one, so the consumer cannot pick
    -- the document type through the number.
    if document_type then
        core.request.set_header(ctx, HEADER, document_type .. ":" .. number)
    else
        core.request.set_header(ctx, HEADER, number)
    end
end

return _M
