{{/* Names: every object is den-<component> in the release's namespace (one DEN per namespace). */}}
{{- define "den.name" -}}den-{{ . }}{{- end -}}

{{- define "den.labels" -}}
app.kubernetes.io/name: {{ include "den.name" .component }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: den
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end -}}

{{- define "den.selector" -}}
app.kubernetes.io/name: {{ include "den.name" .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/* An image of ours: repository:tag, the chart's appVersion when the tag is empty. */}}
{{- define "den.image" -}}
{{- $image := index .root.Values.images .name -}}
{{- printf "%s:%s" $image.repository (default .root.Chart.AppVersion $image.tag) -}}
{{- end -}}

{{/*
The keys of each component's Secret (den-<component>): only what it uses, so a compromised pod
does not read the rest (least privilege). docs/DEPLOYMENT.md §9.2 lists them for the store.
`keys` are copied from the store as they are; `derived` keys are built from them by External
Secrets (with existing Secrets, the operator writes them): connection URLs never disagree with the
passwords, and CloudNativePG gets its basic-auth Secrets. ESO's template braces are escaped here.
*/}}
{{- define "den.secrets" -}}
{{- $o := "{{" }}{{- $c := "}}" }}
{{- $db := include "den.name" "db" }}
{{- $tls := "sslmode=verify-full&sslrootcert=/var/run/den/db-ca/ca.crt" }}
api:
  keys:
    - DB_APP_PASSWORD
    - APISIX_ADMIN_KEY
    - OPA_BUNDLE_TOKEN
    - DEN_END_USER_HASH_SALT
    - DEN_SUBJECT_REF_KEY
    - DEN_TRANSPARENCY_INGEST_TOKEN
    - DEN_TRANSPARENCY_SIGNING_JWK
    - DEN_NODE_CONTROL_TOKEN
    - DEN_VALIDATION_TOKEN
    - DEN_METRICS_TOKEN
    - DEN_CONTRACT_RUNNER_TOKEN
    - DEN_WG_HUB_AGENT_TOKEN
    - DEN_STEP_CA_PROVISIONER_PASSWORD
    - DEN_SECRETS_KEY
    # The previous keys while rotating (OPERATIONS.md §5.6); an empty property otherwise.
    - DEN_SECRETS_KEYS_PREVIOUS
    - DEN_GATEWAY_PROVISIONER_SECRET
    - KEYCLOAK_ADMIN_PASSWORD
    - DEN_CITIZEN_APPS
    - DEN_SMTP_URL
    - DEN_OPENSEARCH_AUTH
  derived:
    DATABASE_URL: 'postgresql://den_app:{{ $o }} .DB_APP_PASSWORD | urlquery {{ $c }}@{{ $db }}-rw:5432/den?{{ $tls }}'
migrate:
  keys: [DB_OWNER_PASSWORD]
  derived:
    DATABASE_MIGRATION_URL: 'postgresql://den:{{ $o }} .DB_OWNER_PASSWORD | urlquery {{ $c }}@{{ $db }}-rw:5432/den?{{ $tls }}'
web:
  keys: [AUTH_SECRET, DEN_PORTAL_WEB_CLIENT_SECRET]
gateway:
  keys: [APISIX_ADMIN_KEY, DEN_APISIX_KEYRING, OPA_BUNDLE_TOKEN, DEN_TRANSPARENCY_INGEST_TOKEN]
wg-hub:
  keys: [DEN_WG_HUB_PRIVATE_KEY, DEN_WG_HUB_AGENT_TOKEN]
contract-runner:
  keys: [DEN_CONTRACT_RUNNER_TOKEN]
access-logs:
  keys: [OPENSEARCH_USER, OPENSEARCH_PASSWORD]
step-ca:
  keys: [DEN_STEP_CA_PROVISIONER_PASSWORD]
keycloak:
  keys:
    - KEYCLOAK_ADMIN_PASSWORD
    - DEN_PORTAL_WEB_CLIENT_SECRET
    - DEN_GATEWAY_PROVISIONER_SECRET
    - KEYCLOAK_SMTP_USER
    - KEYCLOAK_SMTP_PASSWORD
keycloak-citizens:
  keys: [DEN_CITIZEN_APP_CLIENT_SECRET]
prometheus:
  keys: [DEN_METRICS_TOKEN]
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
  derived: { username: den, password: '{{ $o }} .DB_OWNER_PASSWORD {{ $c }}' }
db-app:
  type: kubernetes.io/basic-auth
  keys: [DB_APP_PASSWORD]
  derived: { username: den_app, password: '{{ $o }} .DB_APP_PASSWORD {{ $c }}' }
keycloak-db:
  type: kubernetes.io/basic-auth
  keys: [KEYCLOAK_DB_PASSWORD]
  derived: { username: keycloak, password: '{{ $o }} .KEYCLOAK_DB_PASSWORD {{ $c }}' }
# The object store of the databases' backups (M6-06): an access key that can write only there.
db-backup:
  keys: [DB_BACKUP_ACCESS_KEY_ID, DB_BACKUP_SECRET_ACCESS_KEY]
{{- end -}}

{{/* Whether a component is deployed (its Secret is only made then). */}}
{{- define "den.enabled" -}}
{{- $v := .root.Values -}}
{{- if eq .component "wg-hub" -}}{{ $v.wgHub.enabled }}
{{- else if eq .component "contract-runner" -}}{{ $v.contractRunner.enabled }}
{{- else if eq .component "keycloak-citizens" -}}{{ $v.keycloak.citizensRealm }}
{{- else if eq .component "access-logs" -}}{{ $v.accessLogs.enabled }}
{{- else if eq .component "prometheus" -}}{{ $v.prometheus.enabled }}
{{- else if eq .component "alertmanager" -}}{{ and $v.prometheus.enabled $v.prometheus.alertmanager.enabled }}
{{- else if eq .component "grafana" -}}{{ $v.grafana.enabled }}
{{- else if eq .component "db-backup" -}}{{ $v.postgres.backup.enabled }}
{{- else -}}true{{- end -}}
{{- end -}}

{{/* Service URLs inside the namespace. */}}
{{- define "den.url.api" -}}http://{{ include "den.name" "api" }}:{{ .Values.api.port }}{{- end -}}
{{/* Where applications reach the gateway: https://gatewayHost, or gatewayPublicUrl (with a port). */}}
{{- define "den.url.gatewayPublic" -}}{{ default (printf "https://%s" .Values.gatewayHost) .Values.gatewayPublicUrl }}{{- end -}}
{{- define "den.url.gateway" -}}http://{{ include "den.name" "gateway" }}:9080{{- end -}}

{{/*
The portal's settings that are not secrets (env of the API): the public URLs, where each service
of the platform is, and how the gateway reaches its own sidecars (OPA and the transparency Fluent
Bit run in every gateway pod, on 127.0.0.1).
*/}}
{{- define "den.apiEnv" -}}
- { name: NODE_ENV, value: production }
- { name: API_PORT, value: {{ .Values.api.port | quote }} }
- { name: DEN_COUNTRY, value: {{ .Values.country | quote }} }
# One masked JSON object per line, for the cluster's log collector (ASVS 16.4.3).
- { name: DEN_LOG_FORMAT, value: json }
- { name: DEN_WEB_URL, value: {{ .Values.publicUrl | quote }} }
- { name: KEYCLOAK_URL, value: {{ printf "%s/auth" .Values.publicUrl | quote }} }
- { name: DEN_CITIZEN_ISSUER, value: {{ printf "%s/auth/realms/den-citizens" .Values.publicUrl | quote }} }
- { name: DEN_GATEWAY_PUBLIC_URL, value: {{ include "den.url.gatewayPublic" . | quote }} }
- { name: DEN_GATEWAY_TLS_HOSTS, value: {{ .Values.gatewayHost | quote }} }
- { name: APISIX_ADMIN_URL, value: {{ printf "http://%s:9180" (include "den.name" "gateway-admin") | quote }} }
- { name: DEN_GATEWAY_INTERNAL_URL, value: {{ include "den.url.gateway" . | quote }} }
# Each gateway node counts rate limits locally: the bundle gives each its share (ADR-0020).
- { name: DEN_GATEWAY_NODES, value: {{ .Values.gateway.replicas | quote }} }
- { name: DEN_CONTRACT_RUNNER_GATEWAY_URL, value: {{ include "den.url.gateway" . | quote }} }
- { name: DEN_GATEWAY_PORTAL_API_URL, value: {{ include "den.url.api" . | quote }} }
- { name: DEN_GATEWAY_KEYCLOAK_URL, value: {{ printf "http://%s:8080/auth" (include "den.name" "keycloak") | quote }} }
- { name: DEN_GATEWAY_OPA_URL, value: "http://127.0.0.1:8181" }
- { name: DEN_GATEWAY_TRANSPARENCY_LOG, value: "127.0.0.1:5170" }
- { name: DEN_GATEWAY_ACCESS_LOG_URL, value: {{ printf "http://%s:9880/" (include "den.name" "access-logs") | quote }} }
- { name: DEN_GATEWAY_WG_HUB, value: {{ printf "%s:8443" (include "den.name" "wg-hub") | quote }} }
- { name: DEN_WG_HUB_AGENT_URL, value: {{ printf "http://%s:8090" (include "den.name" "wg-hub") | quote }} }
- { name: DEN_CONTRACT_RUNNER_URL, value: {{ printf "http://%s:8096" (include "den.name" "contract-runner") | quote }} }
{{- if .Values.antivirus.enabled }}
# Every uploaded document is scanned before it is stored (M6-08).
- { name: DEN_CLAMAV_URL, value: {{ printf "tcp://%s:3310" (include "den.name" "clamav") | quote }} }
{{- end }}
- { name: DEN_OPENSEARCH_URL, value: {{ printf "%s://%s:%v" (ternary "https" "http" .Values.accessLogs.opensearch.tls) .Values.accessLogs.opensearch.host .Values.accessLogs.opensearch.port | quote }} }
- { name: DEN_TRUST_PROXY, value: {{ .Values.api.trustProxy | quote }} }
{{- if .Values.opensearch.enabled }}
- { name: NODE_EXTRA_CA_CERTS, value: /var/run/den/internal-ca/ca.crt }
{{- end }}
{{- if .Values.prometheus.enabled }}
- { name: DEN_PROMETHEUS_URL, value: {{ printf "http://%s" (include "den.name" "prometheus") | quote }} }
{{- end }}
{{- with .Values.api.bootstrapAdminEmail }}
- { name: DEN_BOOTSTRAP_ADMIN_EMAIL, value: {{ . | quote }} }
{{- end }}
- { name: DEN_STEP_CA_URL, value: {{ printf "https://%s:9000" (include "den.name" "step-ca") | quote }} }
- { name: DEN_STEP_CA_ROOT_FINGERPRINT, value: {{ required "stepCa.rootFingerprint: the SHA-256 of the network's root" .Values.stepCa.rootFingerprint | quote }} }
{{- range $name, $value := .Values.api.env }}
- { name: {{ $name }}, value: {{ $value | quote }} }
{{- end }}
{{- end -}}

{{/* A NetworkPolicy peer: the pods of a DEN component. */}}
{{- define "den.np.from" -}}
- podSelector:
    matchLabels:
      {{- if eq . "prometheus" }}
      den-network: prometheus
      {{- else }}
      app.kubernetes.io/name: {{ include "den.name" . }}
      {{- end }}
{{- end -}}
