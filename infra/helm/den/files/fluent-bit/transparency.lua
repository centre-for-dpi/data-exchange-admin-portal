-- Transparency pipeline filter (ADR-0015, ARCHITECTURE.md §13). Second privacy barrier after
-- APISIX's log_format: keeps only the allowlisted fields and only the records the transparency
-- register is for.
--
-- APISIX tcp-logger sends a batch as one JSON array, which the tcp input wraps as {"msg": [...]};
-- this filter splits it back into one record per call.
--
-- X-Request-Id (request_id) is not kept (A-4, M-16): the consumer writes it, so it is free text
-- that proves nothing and could carry the number the pseudonym stands for. A gateway still on the
-- old log format sends it; it is dropped here, whatever its length, and the record goes on.
local ALLOWED = {
  ts = true,
  gateway_node = true,
  gateway_request_id = true,
  route_id = true,
  operation = true,
  subscription_id = true,
  consumer_entity = true,
  consumer_app = true,
  purpose = true,
  end_user_hash = true,
  subject_ref = true,
  status = true,
  upstream_status = true,
}

-- Longest value kept: every allowed field is set by the gateway (ids, hashes, codes, statuses)
-- and is far shorter. A longer one is dropped alone, so the record keeps its size bounded and
-- the collector judges the rest; it never takes the other records of the batch with it.
local MAX_LENGTH = 255

local function present(value)
  return type(value) == "string" and value ~= "" and value ~= "-"
end

local function bounded(value)
  if type(value) == "number" then
    return value
  end
  if type(value) == "string" and #value <= MAX_LENGTH then
    return value
  end
  return nil
end

-- Only calls OPA let through to the provider (an upstream answered or was tried) and that carry
-- the data-subject reference OPA computed. A client cannot forge either: $upstream_status is
-- set by nginx when it proxies, and the gateway removes client-sent X-DEN-Subject-Ref before OPA.
local function keep(entry)
  if type(entry) ~= "table" then
    return nil
  end
  if not present(entry.subject_ref) or not present(entry.upstream_status) then
    return nil
  end
  local filtered = {}
  for key, value in pairs(entry) do
    if ALLOWED[key] then
      filtered[key] = bounded(value)
    end
  end
  return filtered
end

function transparency(tag, timestamp, record)
  local entries = record
  if type(record.msg) == "table" then
    entries = record.msg
  else
    entries = { record }
  end
  local out = {}
  for _, entry in ipairs(entries) do
    local kept = keep(entry)
    if kept then
      out[#out + 1] = kept
    end
  end
  if #out == 0 then
    return -1, timestamp, record
  end
  -- 1 = modified; an array of records emits one record per element.
  return 1, timestamp, out
end
