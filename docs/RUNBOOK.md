# Operator runbook

> Versión en español: [docs/es/RUNBOOK.md](es/RUNBOOK.md)

Procedures for the network operator for what is not routine: onboarding an entity, responding to an incident, rotating the intermediate CA and mass-revoking certificates. Daily operation, backups and common problems are in [`OPERATIONS.md`](OPERATIONS.md); deployment, in [`DEPLOYMENT.md`](DEPLOYMENT.md).

Conventions:

- `dc` is Docker Compose with the pilot's files (`OPERATIONS.md §0`). On Kubernetes, the equivalent is `kubectl -n den`.
- **Console** is the portal's operator console (`/operator`). `platform_admin` actions require a second factor.
- Every action in the portal is recorded in the audit log. Whatever is done outside the portal (in Keycloak, on the server) is noted in the incident record (§2.1).

## 1. Onboarding an entity

There are two paths (`SPEC.md §4.1`). In both, the entity becomes active and the portal invites its administrator and its designated officers by email.

| Path | When | Who |
| :-- | :-- | :-- |
| **Onboarding request** | The entity asks for it from the portal: an official with a verified account fills in the details, designates the officers and attaches the designation document (PDF) | A `platform_reviewer` reviews it in Console → Entity onboarding to review |
| **Direct registration** | An act or a decision has already brought the entity into the network | `platform_admin` in Console → Entities → Register entity, citing that basis, which is recorded in the audit log |

### 1.1 Reviewing a request

1. Open the request and the designation document. Check:
   - that the entity exists and that the tax identifier is its own (the portal validates it against the country's format, not against an official registry);
   - that the document designates the people listed as data officer and technical officer, and that it is signed by someone with the authority to do so;
   - that the email addresses of the requester and of the officers are institutional addresses of the entity.
2. Decide:
   - **Request corrections** if something is missing or should not be there: the requester reads the comment.
   - **Reject** if the request is fraudulent or does not apply. It is final, but it frees the identifier for a legitimate request.
   - **Approve**: the entity becomes active, the requester becomes `entity_admin` and the officers receive their invitations (they expire after 14 days, `DEN_INVITATION_TTL_DAYS`).
3. Nobody reviews a request they submitted or in which they are listed as an officer: the portal does not allow it.

### 1.2 After onboarding

| Step | Who | Where |
| :-- | :-- | :-- |
| The officers accept their invitation (they sign in with the invited, verified email address) | Officers | Portal → Invitations |
| If the entity will publish through X-Road: register its X-Road member | `platform_admin` | Console → Entities → the entity |
| Bootcamp readiness: server, read-only user in its database, outbound access on 443, designated officers and use case | Entity administrator or operator | Console → Bootcamp |
| Install the kit node at the entity and enroll it with a one-time token | Entity administrator, with the operator | My entity → Nodes |
| Publish the first API and take it through review | Entity publisher; `platform_reviewer` | My APIs; Console → Reviews |

Check: the entity shows as active in Console → Entities, its node online in Console → Nodes, and its first API in the catalog.

### 1.3 Suspending or offboarding

- **Suspend** (Console → Entities → the entity): with a reason. Its applications stop passing through the gateway and it cannot publish anything new. With "Also as a provider", its APIs stop serving other entities. Reactivating returns each subscription to its previous state.
- **Offboard**: this is final. It closes its subscriptions on both sides, retires its versions and revokes its memberships.

## 2. Incidents

### 2.1 General procedure

1. **Open an incident record** (outside the portal, in the operator's ticketing system): time of detection, who detected it, symptom.
2. **Classify the severity:**

   | Severity | Examples | Response |
   | :-- | :-- | :-- |
   | **Critical** | Personal data leak; compromised key or certificate in use; gateway down for the whole network; audit chain tampered with | Immediate, at any hour. Notify the regulator and the affected entities |
   | **High** | One entity or application compromised; portal down (the gateway keeps working); backups failing | Within the hour, during extended hours |
   | **Medium** | One entity node offline; reconciliation with errors; certificate about to expire | Within the business day |
   | **Low** | Isolated errors with no effect on traffic | In the next planned window |

3. **Contain** with the playbook in §2.2. Cut off access first, investigate afterwards: cutting off is reversible (suspend, revoke) and the investigation can take time.
4. **Preserve the evidence** before changing anything that would erase it:
   - the audit log range (Console → Audit, export with the incident's filters);
   - the logs of the components involved (`dc logs --since <time> <service> > file`);
   - the sync state (Console → Gateway sync).
5. **Recover** and check with `OPERATIONS.md §2.2` (end-to-end check).
6. **Close** with a report: timeline, cause, what was done, who was notified and what changes so it does not happen again. If personal data was involved, the data officer of the provider entity decides on notifying the data subjects according to the country's legal framework.

### 2.2 Playbooks

| Incident | Contain | Recover |
| :-- | :-- | :-- |
| **An application's private key leaked** (its client certificate) | The application's developer revokes the certificate (My applications → the application). If the entity does not respond: mass revocation filtered by entity and issue date (§4), or suspend the application's subscriptions as the operator | The application issues a new certificate with a new private key |
| **Client secret leaked** | The developer rotates the secret and revokes the old one (My applications → Credentials). A secret alone is not enough to make calls if the network requires mTLS: the token is bound to the certificate | — |
| **Entity compromised** (several applications, or it is unknown which ones) | Suspend the entity (§1.3) and mass-revoke its certificates (§4) | Reactivate once the entity confirms it has cleaned up its environment; its applications issue new certificates |
| **User account compromised** | In the Keycloak admin console (realm `den-portal`): disable the user and end their sessions. The entity administrator removes their roles if appropriate (My entity, members). If the alert was a second-factor enrollment the owner did not make (Keycloak email, M3-08): delete that second factor in Keycloak | The owner resets their password and enrolls their second factor again |
| **An entity's node compromised** | Decommission the node: the entity administrator in My entity → Nodes, or the operator through the API (`POST /api/v1/entities/{entityId}/nodes/{nodeId}/decommission`). The gateway stops routing to it and its certificate stops being valid for the control channel | Install the kit on a clean server and enroll it with a new token |
| **Personal data in a log** (an identification number, a response body) | Stop the source. Delete what was written: the affected OpenSearch index, the files or the collector output | Fix the masking and add a regression test (`tests/infra`, rule 2 of CLAUDE.md) |
| **Gateway down** | `dc ps apisix opa etcd`; `dc logs apisix opa`. OPA without a bundle denies everything: see `OPERATIONS.md §7` | Restart the component (`OPERATIONS.md §5.1`); check with a test call |
| **Portal down** (API or web) | The gateway keeps serving with its last configuration and OPA with its last bundle (M6-04). New changes (approvals, revocations) wait | Restart the API; the reconcilers catch up with the database state on their own |
| **Audit chain error** (Console → Audit → Verify integrity) | Export the audit log and the anchors; do not touch the database | Restore the database to an instant before the tampering (`OPERATIONS.md §6`) and compare with the export to find out what changed |
| **Database damaged or deleted by mistake** | Stop the API | `sudo ./install.sh restore [instant]` (`OPERATIONS.md §6`) |
| **Intermediate CA private key compromised** | §3.3 | §3.3 |
| **Gateway assertion signing key compromised** (M6-10) | Rotate it as compromised: `POST /api/v1/admin/gateway-signing-keys/rotate` with `{"compromised": true, "reason": "…"}` (`platform_admin`). The gateway signs with the new one from the reconciler's next pass, within seconds; the old one is removed from the JWKS | Notify the providers: what the compromised key signed no longer verifies, and whoever archived it needs to know from when it stopped being trustworthy (the date is in the audit log, `gateway_signing_key.created`) |
| **Gateway nodes added or removed** (not an incident, but it changes the limits) | — | Adjust `DEN_GATEWAY_NODES` (in the chart, it comes from `gateway.replicas`): each node counts the limits on its own and the bundle gives each one its share (ADR-0020) |

## 3. Rotating the intermediate CA

The network has a root (offline in production) and an intermediate, which step-ca uses to sign the certificates of the applications, the nodes and the gateway. Changing the intermediate does not change the root: what has already been issued stays valid, because it chains to the same root.

What protects the network besides the chain:
- **Applications:** the gateway only accepts the fingerprints of certificates that the portal issued and that are still valid (OPA's list). A certificate made with another intermediate, or with a stolen one, is not on the list.
- **Kit nodes:** the portal binds each node to its certificate's fingerprint on the control channel.
- **The gateway towards the applications:** here only the chain counts. Applications trust the network root to verify the gateway's server certificate.

### 3.1 Planned rotation: pilot (Compose)

The development CA keeps the root, the intermediate and their keys in the `step-ca-data` volume.

1. Back up (`sudo ./install.sh backup`): it includes the CA volume.
2. Create the new intermediate with the root and keep the old one alongside:

   ```bash
   dc exec step-ca sh -c 'cd /home/step &&
     step certificate create "DEN Dev CA Intermediate CA $(date +%Y-%m)" \
       certs/intermediate_ca.next.crt secrets/intermediate_ca_key.next \
       --profile intermediate-ca --ca certs/root_ca.crt --ca-key secrets/root_ca_key \
       --ca-password-file secrets/password --password-file secrets/password --not-after 43800h &&
     mv certs/intermediate_ca.crt certs/intermediate_ca.previous.crt &&
     mv secrets/intermediate_ca_key secrets/intermediate_ca_key.previous &&
     mv certs/intermediate_ca.next.crt certs/intermediate_ca.crt &&
     mv secrets/intermediate_ca_key.next secrets/intermediate_ca_key &&
     step certificate fingerprint certs/intermediate_ca.crt'
   dc restart step-ca
   ```

   The fingerprint it prints is the new intermediate's (SHA-256), the same one that the mass revocation shows (§4).
3. Reissue the gateway's certificates with the new intermediate, so that its chain and the list of CAs it accepts (`client.ca`) include it: delete their rows and restart the API (`OPERATIONS.md §5.6`).
4. Check:
   - a test application issues a new certificate and its issuer is the new intermediate;
   - a call with an old certificate still goes through.

   Applications must present the full chain, as the portal delivers it when issuing: with only the certificate, the gateway cannot chain it to the root.
5. Certificates from the old intermediate are replaced on their own as they expire: the nodes renew theirs before they expire, and the applications receive the expiry notice. To avoid waiting, they can be mass-revoked by issuer (§4) once the applications have issued the new ones.

### 3.2 Planned rotation: Kubernetes

The root is not in the cluster. The intermediate and its key live in the `stepCa.pkiSecret` Secret.

1. With the offline root, on the CA ceremony machine: create the new intermediate (`step certificate create ... --profile intermediate-ca`, as in §3.1) and encrypt its key with `DEN_STEP_CA_PROVISIONER_PASSWORD`.
2. Replace `intermediate_ca.crt` and `intermediate_ca_key` in the Secret (in the secret store, if External Secrets syncs it).
3. `kubectl -n den rollout restart statefulset/den-step-ca`. On every start, step-ca takes the PKI from the Secret.
4. Continue with steps 3 to 5 of §3.1.

### 3.3 Compromised intermediate (emergency)

Whoever holds the intermediate's key can issue certificates that chain to the root.

1. **Contain:** rotate the intermediate right away (§3.1 or §3.2) and reissue the gateway's certificates. From that moment on, step-ca issues only with the new one.
2. **Mass-revoke** everything issued by the compromised intermediate (§4, filter by issuer). Notify the entities so they issue new certificates, and the nodes so they renew.
3. **Assess** what the fingerprint list does not cover: an attacker with the intermediate and a position on the network could impersonate the gateway towards the applications. The gateway does not check intermediate revocation lists (CRLs). If the risk is real, the complete way out is a new root:
   - a ceremony for a new root and a new intermediate;
   - distribute the new root to the applications and the nodes;
   - pin its fingerprint in the portal (`DEN_STEP_CA_ROOT_FINGERPRINT` or `stepCa.rootFingerprint`);
   - reissue everything.

   This is planned with the entities, because every application changes what it trusts.
4. **If the root is the one compromised:** the same new-root plan, immediately.

## 4. Mass certificate revocation

Console → Mass certificate revocation (`/operator/certificates`), `platform_admin` only.

1. **Filter:**
   - by entity;
   - by issue date (from, to; days in UTC);
   - by the intermediate CA that issued them (in the intermediates table, "Only those of…").

   They all combine. With no filters, every valid certificate in the network is revoked: the portal warns about it.
2. **Review the preview:** how many certificates, from how many entities and applications.
3. **Revoke:** with a reason (it is recorded in each certificate's audit log, without personal data) and by confirming the number. If in the meantime someone issued or revoked a certificate in that set, nothing is revoked and you have to look at the preview again.

Effect:
- each certificate becomes `revoked` and the gateway rejects it with the next OPA bundle, in under 60 seconds;
- the developers of each application receive a notice, also by email, which cannot be turned off;
- the audit log has one `credential.revoked` per certificate, with the reason and the revocation identifier, and one `certificate_revocation.executed` with the filters and the total.

It cannot be undone: each application issues a new certificate from its page. Client secrets are not part of the mass revocation; each application rotates its own (§2.2).

Through the API: `GET /api/v1/admin/certificate-revocations/preview` and `POST /api/v1/admin/certificate-revocations` with `expectedCount` (the reference is at `/api/docs`).
