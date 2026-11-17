-- Transparency pipeline filter (ADR-0015, ARCHITECTURE.md §13). Second privacy barrier after
-- APISIX's log_format: keeps only the allowlisted fields and only the records the transparency
-- register is for.
--
-- APISIX tcp-logger sends a batch as one JSON array, which the tcp input wraps as {"msg": [...]};
-- this filter splits it back into one record per call.
local ALLOWED = {
  ts = true,
  gateway_node = true,
  gateway_request_id = true,
  request_id = true,
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

local function present(value)
  return type(value) == "string" and value ~= "" and value ~= "-"
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
      filtered[key] = value
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
