--
-- rid-assertion: the gateway's signed assertion to the provider (SPIKE S-6). After OPA decided,
-- it signs what the gateway vouches for (who calls, for what, under which subscription, the
-- official as its hash, which operation and which request) as a compact JWS (ES256) and sends it
-- in X-RID-Assertion. The provider verifies it with the gateway's public keys (JWKS, published by
-- the portal) and can keep it: the network cannot later deny having authorized the call.
--
-- The key comes in this plugin's metadata (shared by every route), never in a route: the portal
-- would push it like the gateway's TLS keys, encrypted at rest in etcd (encrypt_fields, with the
-- deployment's own data_encryption keyring).
--
-- Priority 2000: right after opa (2001), whose X-RID-* request headers it signs; before
-- limit-count (1002). A route whose metadata is missing fails closed (503): the provider must not
-- receive a call without the assertion it was told to expect.
--
local core = require("apisix.core")
local plugin = require("apisix.plugin")
local pkey = require("resty.openssl.pkey")
local digest = require("resty.openssl.digest")
local lrucache = core.lrucache.new({ ttl = 300, count = 8 })

local plugin_name = "rid-assertion"

local schema = {
    type = "object",
    properties = {
        -- The provider entity the assertion is for (its slug): a token for one provider is
        -- useless at another.
        audience = { type = "string", minLength = 1, maxLength = 128 },
        ttl = { type = "integer", minimum = 10, maximum = 300, default = 60 },
    },
    required = { "audience" },
    additionalProperties = false,
}

local metadata_schema = {
    type = "object",
    properties = {
        issuer = { type = "string", minLength = 1, maxLength = 256 },
        kid = { type = "string", minLength = 1, maxLength = 128 },
        -- PKCS#8 PEM of a P-256 key.
        private_key = { type = "string", minLength = 64 },
    },
    required = { "issuer", "kid", "private_key" },
    encrypt_fields = { "private_key" },
}

local _M = {
    version = 0.1,
    priority = 2000,
    name = plugin_name,
    schema = schema,
    metadata_schema = metadata_schema,
}

function _M.check_schema(conf, schema_type)
    if schema_type == core.schema.TYPE_METADATA then
        return core.schema.check(metadata_schema, conf)
    end
    return core.schema.check(schema, conf)
end

local function b64url(value)
    return (ngx.encode_base64(value):gsub("+", "-"):gsub("/", "_"):gsub("=+$", ""))
end

local function sha256_hex(value)
    local d = digest.new("sha256")
    local raw = d:final(value)
    return (raw:gsub(".", function(c) return string.format("%02x", string.byte(c)) end))
end

-- The signing key, parsed once per kid.
local function signing_key(metadata)
    return lrucache(metadata.kid, nil, function()
        local key, err = pkey.new(metadata.private_key)
        if not key then
            return nil, err
        end
        return key
    end)
end

-- Only values OPA set (rid-header-guard removed any a client sent); empty ones are left out.
local CLAIMED = {
    consumer_entity = "x-rid-consumer-entity",
    consumer_app = "x-rid-consumer-app",
    subscription = "x-rid-subscription",
    purpose = "x-rid-purpose",
    operation = "x-rid-operation",
    end_user_hash = "x-rid-end-user-hash",
    subject_ref = "x-rid-subject-ref",
}

function _M.access(conf, ctx)
    local metadata = plugin.plugin_metadata(plugin_name)
    if not metadata or not metadata.value then
        core.log.error("rid-assertion: no signing key in the plugin metadata")
        return 503
    end
    local key, err = signing_key(metadata.value)
    if not key then
        core.log.error("rid-assertion: signing key not usable: ", err)
        return 503
    end

    local rid = {}
    for claim, header in pairs(CLAIMED) do
        local value = core.request.header(ctx, header)
        if type(value) == "string" and value ~= "" then
            rid[claim] = value
        end
    end
    local now = ngx.time()
    -- What the provider receives, after the gateway's rewrite: the hash binds the assertion to
    -- this request without carrying the path (identification numbers) in the token.
    local upstream_uri = ctx.var.upstream_uri or ngx.var.request_uri
    local claims = {
        iss = metadata.value.issuer,
        aud = conf.audience,
        iat = now,
        exp = now + conf.ttl,
        jti = ngx.var.request_id,
        rid = rid,
        req = {
            method = ngx.req.get_method(),
            uri_sha256 = sha256_hex(upstream_uri),
        },
    }
    local header = { alg = "ES256", typ = "JWT", kid = metadata.value.kid }
    local input = b64url(core.json.encode(header)) .. "." .. b64url(core.json.encode(claims))
    local signature, sign_err = key:sign(input, "sha256", nil, { ecdsa_use_raw = true })
    if not signature then
        core.log.error("rid-assertion: signing failed: ", sign_err)
        return 503
    end
    core.request.set_header(ctx, "X-RID-Assertion", input .. "." .. b64url(signature))
end

return _M
