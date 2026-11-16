-- Access-log filter (ARCHITECTURE.md §8, M5-01). Second privacy barrier after APISIX's
-- log_format: drops every field that is not in the allowlist, so the real URI, the query string,
-- bodies, Authorization and any other header never reach OpenSearch. Then it shapes the record
-- for the analytics (numbers as numbers, latencies in milliseconds) and checks the format of
-- every value: one that does not look like what the gateway puts there is dropped, so a client
-- cannot smuggle an identification number into the index through a header it chooses
-- (X-RID-Purpose, X-Request-Id).
local ALLOWED = {
  ts = true,
  request_id = true,
  route_id = true,
  operation = true,
  method = true,
  status = true,
  latency_ms = true,
  upstream_latency_ms = true,
  consumer_entity = true,
  consumer_app = true,
  subscription_id = true,
  purpose = true,
  end_user_hash = true,
  bytes_sent = true,
  gateway_node = true,
  -- Stable reason of a denial (no_subscription, end_user_required...): analytics of refusals.
  deny_reason = true,
}

-- Lua patterns each value must match whole; a value that does not is dropped.
local FORMAT = {
  ts = "^%d%d%d%d%-%d%d%-%d%dT[%d:%.]+[Z%+%-][%d:]*$",
  -- Chosen by the consumer: its own trace id.
  request_id = "^[%w%.:_%-]+$",
  route_id = "^rid%-[%w%-]+$",
  operation = "^[%w%._%-]+$",
  method = "^%u+$",
  consumer_entity = "^[%l%d%-]+$",
  consumer_app = "^[%w%-]+$",
  subscription_id = "^[%x%-]+$",
  -- Declared by the consumer: a purpose code, never free text.
  purpose = "^%l[%l%d_]*$",
  end_user_hash = "^%x+$",
  gateway_node = "^[%w%.%-]+$",
  deny_reason = "^%l[%l_]*$",
}

local MAX_LENGTH = 128

local function present(value)
  return type(value) == "string" and value ~= "" and value ~= "-"
end

local function text(key, value)
  if not present(value) or #value > MAX_LENGTH then
    return nil
  end
  if string.match(value, FORMAT[key]) then
    return value
  end
  return nil
end

local function integer(value)
  local number = tonumber(value)
  if number == nil or number < 0 or number ~= math.floor(number) then
    return nil
  end
  return math.floor(number)
end

-- nginx times are seconds with millisecond resolution ("0.012"). $upstream_response_time lists
-- one time per upstream tried ("0.010, 0.004", "0.010 : 0.002"): their sum is the time spent
-- in the upstreams.
local function milliseconds(value)
  if type(value) == "number" then
    value = tostring(value)
  end
  if not present(value) then
    return nil
  end
  local total, found = 0, false
  for part in string.gmatch(value, "[%d%.]+") do
    local seconds = tonumber(part)
    if seconds then
      total = total + seconds
      found = true
    end
  end
  if not found then
    return nil
  end
  return math.floor(total * 1000000 + 0.5) / 1000
end

local SHAPE = {
  status = integer,
  bytes_sent = integer,
  latency_ms = milliseconds,
  upstream_latency_ms = milliseconds,
}

function allowlist(tag, timestamp, record)
  local filtered = {}
  for key, value in pairs(record) do
    if ALLOWED[key] then
      local shape = SHAPE[key]
      if shape then
        filtered[key] = shape(value)
      else
        filtered[key] = text(key, value)
      end
    end
  end
  -- A denial is the gateway's own answer: no upstream was contacted, so nginx set no upstream
  -- time. When a provider answered, a deny reason is one it sent (a response header the gateway
  -- could not strip, such as X_RID_Deny_Reason) and is not kept.
  if filtered.upstream_latency_ms ~= nil then
    filtered.deny_reason = nil
  end
  -- A denied call never reaches the provider, so OPA has no request headers to set: it names
  -- the consumer in its deny response instead (deny_consumer_*), only for a known client.
  if filtered.consumer_app == nil and filtered.deny_reason ~= nil then
    filtered.consumer_app = text("consumer_app", record.deny_consumer_app)
    filtered.consumer_entity = text("consumer_entity", record.deny_consumer_entity)
  end
  -- 1 = record modified, keep original timestamp
  return 1, timestamp, filtered
end
