--
-- rid-client-cert: passes OPA the thumbprint of the client certificate verified in the TLS
-- handshake (SPIKE S-3, ARCHITECTURE.md §3.2).
--
-- RFC 8705 x5t#S256: base64url (no padding) of the SHA-256 of the certificate's DER. nginx's
-- $ssl_client_fingerprint is the SHA-1 and cannot be used. The value goes in
-- X-RID-Client-Cert-S256, after removing whatever the client sent in that header, and only when
-- nginx verified the certificate against the network CA (ssl_client_verify = SUCCESS). OPA compares
-- it with the token's cnf["x5t#S256"] and with the application's valid certificates, and never
-- returns it, so the opa plugin removes it before the upstream (SPIKE S-1).
--
-- Runs in the rewrite phase after openid-connect (2599), so unauthenticated calls are rejected
-- first, and before proxy-rewrite (1008) and opa (access phase).
--
local core = require("apisix.core")
local ngx_ssl = require("ngx.ssl")
local resty_sha256 = require("resty.sha256")

local HEADER = "X-RID-Client-Cert-S256"

local schema = {
    type = "object",
    properties = {},
    additionalProperties = false,
}

local _M = {
    version = 0.1,
    priority = 1025,
    name = "rid-client-cert",
    schema = schema,
}

function _M.check_schema(conf)
    return core.schema.check(schema, conf)
end

local function thumbprint(pem)
    local der = ngx_ssl.cert_pem_to_der(pem)
    if not der then
        return nil
    end
    local sha = resty_sha256:new()
    sha:update(der)
    local b64 = ngx.encode_base64(sha:final())
    return (b64:gsub("[+/=]", { ["+"] = "-", ["/"] = "_", ["="] = "" }))
end

function _M.rewrite(_conf, ctx)
    -- A client never chooses the value: remove it before anything reads it.
    core.request.set_header(ctx, HEADER, nil)
    if ngx.var.https ~= "on" or ngx.var.ssl_client_verify ~= "SUCCESS" then
        return
    end
    local pem = ngx.var.ssl_client_raw_cert
    if not pem then
        return
    end
    local value = thumbprint(pem)
    if value then
        core.request.set_header(ctx, HEADER, value)
    end
end

return _M
