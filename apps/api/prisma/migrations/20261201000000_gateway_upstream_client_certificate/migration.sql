-- M3-03: the gateway's TLS client certificate towards upstreams.

-- AlterEnum
ALTER TYPE "gateway_certificate_purpose" ADD VALUE 'upstream_client';
