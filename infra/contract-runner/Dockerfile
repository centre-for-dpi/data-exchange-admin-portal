# Contract test runner (M4-06): Schemathesis (MIT) behind a small internal HTTP API, so the portal
# can test an API version's sandbox through the gateway when it goes to review.
FROM alpine:3.22
RUN apk add --no-cache python3 \
 && python3 -m venv /opt/st \
 && /opt/st/bin/pip install --no-cache-dir schemathesis==4.33.4 \
 && adduser -D -H runner
ENV PATH="/opt/st/bin:${PATH}"
COPY runner.py /rid/runner.py
USER runner
EXPOSE 8096
CMD ["python3", "/rid/runner.py"]
