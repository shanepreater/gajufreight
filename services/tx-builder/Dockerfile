# tx-builder image (ADR 0012). Build from the repo root:
#   docker build -f services/tx-builder/Dockerfile --build-arg NETWORK=build .
# NETWORK picks contracts/networks/<NETWORK>.json; "build" has a placeholder platform
# address, so use the real network once Platform is deployed there (#71).
# Sophia and Hakuzaru come from the pinned build (contracts/tools/build-toolchain.sh,
# threat model G1). The image holds no keys.

# ── Toolchain: Sophia 9.0.0 and Hakuzaru 0.9.1 from pinned commits ──────────────────
FROM erlang:27@sha256:129dce8daf0e79d52ee0aafca8c4336a9f1081fa448162d7fa6e75433becc859 AS toolchain
COPY contracts/tools/build-toolchain.sh /src/build-toolchain.sh
RUN /src/build-toolchain.sh /opt/toolchain \
 && find /opt/toolchain/lib -mindepth 2 -maxdepth 2 -name .git -exec rm -rf {} +

# ── Contracts for the network, and the service itself ────────────────────────────────
FROM toolchain AS build
ARG NETWORK=build
WORKDIR /src
COPY contracts contracts
COPY services/tx-builder/src services/tx-builder/src
RUN SOPHIA_LIBS=/opt/toolchain escript contracts/tools/build.escript --network "$NETWORK" \
 && mkdir -p /app/ebin \
 && ERL_LIBS=/opt/toolchain/lib erlc -Wall -Werror -o /app/ebin services/tx-builder/src/*.erl \
 && cp services/tx-builder/src/tx_builder.app.src /app/ebin/tx_builder.app \
 && cp -r "contracts/build/$NETWORK" /app/contracts

# ── Runtime ──────────────────────────────────────────────────────────────────────────
FROM erlang:27-slim@sha256:600f0c0d8a1167bdeb8b7d055c9100d9b0b072b8b5ef2ad229a72202e83b7fe4
COPY --from=toolchain /opt/toolchain/lib /opt/toolchain/lib
COPY --from=build /app /app
RUN useradd --system --uid 10001 --home-dir /app txbuilder
USER 10001
WORKDIR /app
ENV ERL_LIBS=/opt/toolchain/lib \
    TX_BUILDER_CONTRACTS=/app/contracts \
    TX_BUILDER_BIND=0.0.0.0 \
    TX_BUILDER_PORT=8790
EXPOSE 8790
# bash's /dev/tcp, as the slim image has no curl or wget.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${TX_BUILDER_PORT} && printf 'GET /health HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q '\"ok\"' <&3"]
CMD ["erl", "-noshell", "-pa", "/app/ebin", "-eval", "application:ensure_all_started(tx_builder)"]
