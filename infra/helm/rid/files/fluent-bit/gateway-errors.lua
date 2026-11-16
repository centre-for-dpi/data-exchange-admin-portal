-- Masks the gateway's error log (gateway-errors.yaml, M5-01). nginx appends to an error inside a
-- request the request line, the upstream URI, the host and the referrer: the path and the query
-- carry identification numbers, so all of them are masked, and so is any query string or long
-- run of digits left in the message. Only the masked message and its program are kept.
local REQUEST = ', request: "'
local REQUEST_ID = ', request_id: "'

local function mask(message)
  -- Everything nginx appends after the request line comes from the client or is derived from it
  -- (the request line, the upstream URI, the host, the referrer), and a client can put quotes or
  -- fake field names in its path: so from the request line to the end, all of it is masked. The
  -- one field kept is APISIX's own request id, the last one, when it is exactly that.
  local start = string.find(message, REQUEST, 1, true)
  if start then
    local last, from = nil, start
    while true do
      local i = string.find(message, REQUEST_ID, from + 1, true)
      if not i then
        break
      end
      last, from = i, i
    end
    local tail = ""
    if last and string.match(string.sub(message, last), '^, request_id: "%x+"$') then
      tail = string.sub(message, last)
    end
    message = string.sub(message, 1, start - 1) .. ', request: "[masked]"' .. tail
  end
  -- Lua errors can quote a path outside that context.
  message = string.gsub(message, '%?[^%s",]+', "?[masked]")
  -- Identification numbers have six digits or more; times, ports and pids are shorter.
  message = string.gsub(message, "%d%d%d%d%d%d+", "[n]")
  return message
end

function scrub(tag, timestamp, record)
  if type(record.message) ~= "string" then
    return -1, timestamp, record
  end
  return 1, timestamp, { ident = record.ident, message = mask(record.message) }
end
