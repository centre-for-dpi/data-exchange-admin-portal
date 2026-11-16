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
`keys` are copied from the store as they are; `derived` keys are built from them by External
Secrets (with existing Secrets, the operator writes them): connection URLs never disagree with the
passwords, and CloudNativePG gets its basic-auth Secrets. ESO's template braces are escaped here.
*/}}
{{- define "rid.secrets" -}}
{{- $o := "{{" }}{{- $c := "}}" }}
{{- $db := include "rid.name" "db" }}
{{- $tls := "sslmode=verify-full&sslrootcert=/var/run/rid/db-ca/ca.crt" }}
api:
  keys:
    - DB_APP_PASSWORD
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
  derived:
    DATABASE_URL: 'postgresql://rid_app:{{ $o }} .DB_APP_PASSWORD | urlquery {{ $c }}@{{ $db }}-rw:5432/rid?{{ $tls }}'
migrate:
  keys: [DB_OWNER_PASSWORD]
  derived:
    DATABASE_MIGRATION_URL: 'postgresql://rid:{{ $o }} .DB_OWNER_PASSWORD | urlquery {{ $c }}@{{ $db }}-rw:5432/rid?{{ $tls }}'
web:
  keys: [AUTH_SECRET, RID_PORTAL_WEB_CLIENT_SECRET]
gateway:
  keys: [APISIX_ADMIN_KEY, RID_APISIX_KEYRING, OPA_BUNDLE_TOKEN, RID_TRANSPARENCY_INGEST_TOKEN]
wg-hub:
  keys: [RID_WG_HUB_PRIVATE_KEY, RID_WG_HUB_AGENT_TOKEN]
contract-runner:
  keys: [RID_CONTRACT_RUNNER_TOKEN]
access-logs:
  keys: [OPENSEARCH_USER, OPENSEARCH_PASSWORD]
step-ca:
  keys: [RID_STEP_CA_PROVISIONER_PASSWORD]
keycloak:
  keys:
    - KEYCLOAK_ADMIN_PASSWORD
    - RID_PORTAL_WEB_CLIENT_SECRET
    - RID_GATEWAY_PROVISIONER_SECRET
    - KEYCLOAK_SMTP_USER
    - KEYCLOAK_SMTP_PASSWORD
keycloak-citizens:
  keys: [RID_CARPETA_CLIENT_SECRET]
prometheus:
  keys: [RID_METRICS_TOKEN]
alertmanager:
  keys: [ALERTMANAGER_SMTP_PASSWORD]
grafana:
  keys: [GRAFANA_ADMIN_PASSWORD]
  derived: { GRAFANA_ADMIN_USER: admin }
# CloudNativePG's roles (kubernetes.io/basic-auth): the owner of the schema, the API's runtime
# role, and Keycloak's own database.
db-owner:
  type: kubernetes.io/basic-auth
  keys: [DB_OWNER_PASSWORD]
  derived: { username: rid, password: '{{ $o }} .DB_OWNER_PASSWORD {{ $c }}' }
db-app:
  type: kubernetes.io/basic-auth
  keys: [DB_APP_PASSWORD]
  derived: { username: rid_app, password: '{{ $o }} .DB_APP_PASSWORD {{ $c }}' }
keycloak-db:
  type: kubernetes.io/basic-auth
  keys: [KEYCLOAK_DB_PASSWORD]
  derived: { username: keycloak, password: '{{ $o }} .KEYCLOAK_DB_PASSWORD {{ $c }}' }
{{- end -}}

{{/* Whether a component is deployed (its Secret is only made then). */}}
{{- define "rid.enabled" -}}
{{- $v := .root.Values -}}
{{- if eq .component "wg-hub" -}}{{ $v.wgHub.enabled }}
{{- else if eq .component "contract-runner" -}}{{ $v.contractRunner.enabled }}
{{- else if eq .component "keycloak-citizens" -}}{{ $v.keycloak.citizensRealm }}
{{- else if eq .component "access-logs" -}}{{ $v.accessLogs.enabled }}
{{- else if eq .component "prometheus" -}}{{ $v.prometheus.enabled }}
{{- else if eq .component "alertmanager" -}}{{ and $v.prometheus.enabled $v.prometheus.alertmanager.enabled }}
{{- else if eq .component "grafana" -}}{{ $v.grafana.enabled }}
{{- else -}}true{{- end -}}
{{- end -}}

{{/* Service URLs inside the namespace. */}}
{{- define "rid.url.api" -}}http://{{ include "rid.name" "api" }}:{{ .Values.api.port }}{{- end -}}
{{/* Where applications reach the gateway: https://gatewayHost, or gatewayPublicUrl (with a port). */}}
{{- define "rid.url.gatewayPublic" -}}{{ default (printf "https://%s" .Values.gatewayHost) .Values.gatewayPublicUrl }}{{- end -}}
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
- { name: RID_GATEWAY_PUBLIC_URL, value: {{ include "rid.url.gatewayPublic" . | quote }} }
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
{{- if .Values.opensearch.enabled }}
- { name: NODE_EXTRA_CA_CERTS, value: /var/run/rid/internal-ca/ca.crt }
{{- end }}
{{- if .Values.prometheus.enabled }}
- { name: RID_PROMETHEUS_URL, value: {{ printf "http://%s" (include "rid.name" "prometheus") | quote }} }
{{- end }}
{{- with .Values.api.bootstrapAdminEmail }}
- { name: RID_BOOTSTRAP_ADMIN_EMAIL, value: {{ . | quote }} }
{{- end }}
- { name: RID_STEP_CA_URL, value: {{ printf "https://%s:9000" (include "rid.name" "step-ca") | quote }} }
- { name: RID_STEP_CA_ROOT_FINGERPRINT, value: {{ required "stepCa.rootFingerprint: the SHA-256 of the network's root" .Values.stepCa.rootFingerprint | quote }} }
{{- range $name, $value := .Values.api.env }}
- { name: {{ $name }}, value: {{ $value | quote }} }
{{- end }}
{{- end -}}

{{/* A NetworkPolicy peer: the pods of a RID component. */}}
{{- define "rid.np.from" -}}
- podSelector:
    matchLabels:
      {{- if eq . "prometheus" }}
      rid-network: prometheus
      {{- else }}
      app.kubernetes.io/name: {{ include "rid.name" . }}
      {{- end }}
{{- end -}}
