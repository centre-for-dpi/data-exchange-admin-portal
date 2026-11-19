# Contract test runner (M4-06): Schemathesis (MIT) behind a small internal HTTP API, so the portal
# can test an API version's sandbox through the gateway when it goes to review.
FROM alpine:3.22
# Exactly the pinned packages, each with its license recorded (requirements.txt, B-32): no
# dependency resolved at build time, and `pip check` fails if one is missing.
COPY requirements.txt /tmp/requirements.txt
RUN apk add --no-cache python3 \
 && python3 -m venv /opt/st \
 && /opt/st/bin/pip install --no-cache-dir --no-deps -r /tmp/requirements.txt \
 && /opt/st/bin/pip check \
 && rm /tmp/requirements.txt \
 && adduser -D -H runner
ENV PATH="/opt/st/bin:${PATH}"
COPY runner.py /den/runner.py
USER runner
EXPOSE 8096
CMD ["python3", "/den/runner.py"]
