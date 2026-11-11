-- Drops every field that is not in the access-log allowlist (ARCHITECTURE.md §8).
-- Real URI, query string, bodies, Authorization and any other header never reach OpenSearch.
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
}

function allowlist(tag, timestamp, record)
  local filtered = {}
  for key, value in pairs(record) do
    if ALLOWED[key] then
      filtered[key] = value
    end
  end
  -- 1 = record modified, keep original timestamp
  return 1, timestamp, filtered
end
