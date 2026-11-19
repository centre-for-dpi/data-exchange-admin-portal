# etcd-init (B-15, ADR-0031): etcdctl, from the etcd image (distroless, no shell), on the step-ca
# image the stack already uses for its other one-shot init containers (it has a shell). It runs
# infra/etcd/init.sh, mounted read-only, before APISIX on every start.
FROM quay.io/coreos/etcd:v3.6.16@sha256:a9c7cc12156f4b26ca41f0b57ba5b76c45037ff6c1e47ea3d68cb7908d48a965 AS etcd
FROM smallstep/step-ca:0.30.2@sha256:a2b17872915c193259b75a5474c398326f41bd199f0842093e52cf4182bc8270
COPY --from=etcd /usr/local/bin/etcdctl /usr/local/bin/etcdctl
