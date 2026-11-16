{{/* Names: every object is rid-<component> in the release's namespace (one RID per namespace). */}}
{{- define "rid.name" -}}rid-{{ . }}{{- end -}}

{{- define "rid.labels" -}}
app.kubernetes.io/name: {{ include "rid.name" .component }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: rid
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end -}}

{{- define "rid.selector" -}}
app.kubernetes.io/name: {{ include "rid.name" .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/* An image of ours: repository:tag, the chart's appVersion when the tag is empty. */}}
{{- define "rid.image" -}}
{{- $image := index .root.Values.images .name -}}
{{- printf "%s:%s" $image.repository (default .root.Chart.AppVersion $image.tag) -}}
{{- end -}}

{{/*
The keys of each component's Secret (rid-<component>): only what it uses, so a compromised pod
does not read the rest (least privilege). docs/DEPLOYMENT.md §9.2 lists them for the store.
*/}}
{{- define "rid.secretKeys" -}}
api:
  - DATABASE_URL
  - APISIX_ADMIN_KEY
  - OPA_BUNDLE_TOKEN
  - RID_END_USER_HASH_SALT
  - RID_SUBJECT_REF_KEY
  - RID_TRANSPARENCY_INGEST_TOKEN
  - RID_TRANSPARENCY_SIGNING_JWK
  - RID_NODE_CONTROL_TOKEN
  - RID_VALIDATION_TOKEN
  - RID_METRICS_TOKEN
  - RID_CONTRACT_RUNNER_TOKEN
  - RID_WG_HUB_AGENT_TOKEN
  - RID_STEP_CA_PROVISIONER_PASSWORD
  - RID_SECRETS_KEY
  - RID_GATEWAY_PROVISIONER_SECRET
  - KEYCLOAK_ADMIN_PASSWORD
  - RID_CITIZEN_APPS
  - RID_SMTP_URL
  - RID_OPENSEARCH_AUTH
migrate:
  - DATABASE_MIGRATION_URL
web:
  - AUTH_SECRET
  - RID_PORTAL_WEB_CLIENT_SECRET
gateway:
  - APISIX_ADMIN_KEY
  - RID_APISIX_KEYRING
  - OPA_BUNDLE_TOKEN
  - RID_TRANSPARENCY_INGEST_TOKEN
wg-hub:
  - RID_WG_HUB_PRIVATE_KEY
  - RID_WG_HUB_AGENT_TOKEN
contract-runner:
  - RID_CONTRACT_RUNNER_TOKEN
access-logs:
  - OPENSEARCH_USER
  - OPENSEARCH_PASSWORD
{{- end -}}

{{/* Whether a component is deployed (its Secret is only made then). */}}
{{- define "rid.enabled" -}}
{{- $v := .root.Values -}}
{{- if eq .component "wg-hub" -}}{{ $v.wgHub.enabled }}
{{- else if eq .component "contract-runner" -}}{{ $v.contractRunner.enabled }}
{{- else -}}true{{- end -}}
{{- end -}}

{{/* Service URLs inside the namespace. */}}
{{- define "rid.url.api" -}}http://{{ include "rid.name" "api" }}:{{ .Values.api.port }}{{- end -}}
{{- define "rid.url.gateway" -}}http://{{ include "rid.name" "gateway" }}:9080{{- end -}}

{{/*
The portal's settings that are not secrets (env of the API): the public URLs, where each service
of the platform is, and how the gateway reaches its own sidecars (OPA and the transparency Fluent
Bit run in every gateway pod, on 127.0.0.1).
*/}}
{{- define "rid.apiEnv" -}}
- { name: NODE_ENV, value: production }
- { name: API_PORT, value: {{ .Values.api.port | quote }} }
- { name: RID_COUNTRY, value: {{ .Values.country | quote }} }
- { name: RID_WEB_URL, value: {{ .Values.publicUrl | quote }} }
- { name: KEYCLOAK_URL, value: {{ printf "%s/auth" .Values.publicUrl | quote }} }
- { name: RID_CITIZEN_ISSUER, value: {{ printf "%s/auth/realms/rid-citizens" .Values.publicUrl | quote }} }
- { name: RID_GATEWAY_PUBLIC_URL, value: {{ printf "https://%s" .Values.gatewayHost | quote }} }
- { name: RID_GATEWAY_TLS_HOSTS, value: {{ .Values.gatewayHost | quote }} }
- { name: APISIX_ADMIN_URL, value: {{ printf "http://%s:9180" (include "rid.name" "gateway-admin") | quote }} }
- { name: RID_GATEWAY_INTERNAL_URL, value: {{ include "rid.url.gateway" . | quote }} }
- { name: RID_CONTRACT_RUNNER_GATEWAY_URL, value: {{ include "rid.url.gateway" . | quote }} }
- { name: RID_GATEWAY_PORTAL_API_URL, value: {{ include "rid.url.api" . | quote }} }
- { name: RID_GATEWAY_KEYCLOAK_URL, value: {{ printf "http://%s:8080/auth" (include "rid.name" "keycloak") | quote }} }
- { name: RID_GATEWAY_OPA_URL, value: "http://127.0.0.1:8181" }
- { name: RID_GATEWAY_TRANSPARENCY_LOG, value: "127.0.0.1:5170" }
- { name: RID_GATEWAY_ACCESS_LOG_URL, value: {{ printf "http://%s:9880/" (include "rid.name" "access-logs") | quote }} }
- { name: RID_GATEWAY_WG_HUB, value: {{ printf "%s:8443" (include "rid.name" "wg-hub") | quote }} }
- { name: RID_WG_HUB_AGENT_URL, value: {{ printf "http://%s:8090" (include "rid.name" "wg-hub") | quote }} }
- { name: RID_CONTRACT_RUNNER_URL, value: {{ printf "http://%s:8096" (include "rid.name" "contract-runner") | quote }} }
- { name: RID_OPENSEARCH_URL, value: {{ printf "%s://%s:%v" (ternary "https" "http" .Values.accessLogs.opensearch.tls) .Values.accessLogs.opensearch.host .Values.accessLogs.opensearch.port | quote }} }
- { name: RID_TRUST_PROXY, value: {{ .Values.api.trustProxy | quote }} }
{{- range $name, $value := .Values.api.env }}
- { name: {{ $name }}, value: {{ $value | quote }} }
{{- end }}
{{- end -}}

{{/* A NetworkPolicy peer: the pods of a RID component. */}}
{{- define "rid.np.from" -}}
- podSelector:
    matchLabels:
      app.kubernetes.io/name: {{ include "rid.name" . }}
{{- end -}}
