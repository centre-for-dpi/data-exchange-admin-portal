# etcd-init (B-15, ADR-0031): etcdctl, from the etcd image (distroless, no shell), on the step-ca
# image the stack already uses for its other one-shot init containers (it has a shell). It runs
# infra/etcd/init.sh, mounted read-only, before APISIX on every start.
FROM quay.io/coreos/etcd:v3.6.16 AS etcd
FROM smallstep/step-ca:0.30.2
COPY --from=etcd /usr/local/bin/etcdctl /usr/local/bin/etcdctl
