-- Masks the gateway's error log (gateway-errors.yaml, M5-01). nginx appends to an error inside a
-- request the request line, the upstream URI, the host and the referrer: the path and the query
-- carry identification numbers, so all of them are masked, and so is any query string or long
-- run of digits left in the message (Lua errors can quote a path). Only the masked message, its
-- program and its time are kept.
local function mask(message)
  message = string.gsub(message, ', request: "[^"]*"', ', request: "[masked]"')
  message = string.gsub(message, ', upstream: "[^"]*"', ', upstream: "[masked]"')
  message = string.gsub(message, ', referrer: "[^"]*"', ', referrer: "[masked]"')
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
