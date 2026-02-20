ARG BUILD_SHA
ARG BUILD_NUMBER
ARG BUILD_TIMESTAMP
ARG RELEASE_CHANNEL=nightly

FROM node:24-trixie-slim AS base

WORKDIR /usr/src/app

RUN corepack enable && corepack prepare pnpm@10.26.0 --activate

RUN apt-get update && apt-get install -y --no-install-recommends \
	curl \
	ca-certificates \
	python3 \
	make \
	g++ \
	&& rm -rf /var/lib/apt/lists/*

FROM base AS deps

COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY package.json ./
COPY patches/ ./patches/

COPY packages/ ./packages/
COPY fluxer_server/package.json ./fluxer_server/
COPY fluxer_app/package.json ./fluxer_app/

RUN pnpm install --frozen-lockfile

RUN pnpm approve-builds msgpackr-extract@3.0.3 @parcel/watcher@2.5.6

RUN pnpm rebuild msgpackr-extract @parcel/watcher

FROM deps AS build

COPY tsconfigs /usr/src/app/tsconfigs

COPY packages/ ./packages/
RUN pnpm --filter @fluxer/config generate
COPY fluxer_server/ ./fluxer_server/

RUN pnpm --filter @fluxer/admin build:css \
	&& pnpm --filter @fluxer/marketing build:css

COPY fluxer_media_proxy/data/model.onnx ./fluxer_media_proxy/data/model.onnx

RUN cd fluxer_server && pnpm typecheck

FROM erlang:28-slim AS gateway-build

ARG LOGGER_LEVEL=info

WORKDIR /usr/src/app/gateway

RUN apt-get update && apt-get install -y --no-install-recommends \
	git \
	curl \
	make \
	gcc \
	g++ \
	libc6-dev \
	ca-certificates \
	gettext-base \
	&& rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://github.com/erlang/rebar3/releases/download/3.24.0/rebar3 -o /usr/local/bin/rebar3 && \
	chmod +x /usr/local/bin/rebar3

COPY fluxer_gateway/rebar.config fluxer_gateway/rebar.lock* ./
RUN rebar3 compile --deps_only

COPY fluxer_gateway/. ./fluxer_gateway
RUN LOGGER_LEVEL=${LOGGER_LEVEL} envsubst '${LOGGER_LEVEL}' < fluxer_gateway/config/vm.args.template > fluxer_gateway/config/vm.args && \
	LOGGER_LEVEL=${LOGGER_LEVEL} envsubst '${LOGGER_LEVEL}' < fluxer_gateway/config/sys.config.template > fluxer_gateway/config/sys.config && \
	(cd fluxer_gateway && rebar3 as prod release)

FROM deps AS app-build

# fluxer_app build runs wasm-pack, which requires cargo and wasm32 target.
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable && \
	/root/.cargo/bin/rustup target add wasm32-unknown-unknown

ENV PATH="/root/.cargo/bin:${PATH}"

COPY tsconfigs /usr/src/app/tsconfigs

COPY packages/ ./packages/
COPY fluxer_app/ ./fluxer_app/
COPY fluxer_static/ ./fluxer_static/
COPY config/config.app-build.json /usr/src/app/config/config.app-build.json

ENV FLUXER_CONFIG=/usr/src/app/config/config.app-build.json

RUN cd fluxer_app && pnpm lingui:compile && pnpm build

FROM node:24-trixie-slim AS production

ARG BUILD_SHA
ARG BUILD_NUMBER
ARG BUILD_TIMESTAMP
ARG RELEASE_CHANNEL

LABEL org.opencontainers.image.title="Fluxer Server"
LABEL org.opencontainers.image.description="Unified Fluxer server for self-hosting - combines all backend services into a single deployable container"
LABEL org.opencontainers.image.vendor="Fluxer Contributors"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.source="https://github.com/fluxerapp/fluxer"
LABEL org.opencontainers.image.documentation="https://docs.fluxer.app"
LABEL org.opencontainers.image.revision="${BUILD_SHA}"
LABEL org.opencontainers.image.version="${BUILD_NUMBER}"
LABEL org.opencontainers.image.created="${BUILD_TIMESTAMP}"

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y --no-install-recommends \
	curl \
	ffmpeg \
	&& rm -rf /var/lib/apt/lists/*


RUN corepack enable && corepack prepare pnpm@10.26.0 --activate

COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/packages ./packages
COPY --from=build /usr/src/app/fluxer_server ./fluxer_server
COPY --from=build /usr/src/app/tsconfigs ./tsconfigs
COPY --from=build /usr/src/app/pnpm-workspace.yaml ./
COPY --from=build /usr/src/app/package.json ./
COPY --from=gateway-build /usr/src/app/gateway/fluxer_gateway/_build/prod/rel/fluxer_gateway /opt/fluxer_gateway
COPY --from=app-build /usr/src/app/fluxer_app/dist /usr/src/app/assets
COPY --from=app-build /usr/src/app/fluxer_static/ /usr/src/app/assets/

RUN mkdir -p /usr/src/app/data/storage && \
	mkdir -p /usr/src/app/data/db && \
	mkdir -p /opt/data && \
	mkdir -p /data/s3 && \
	mkdir -p /data/sqlite && \
	mkdir -p /data/queue && \
	mkdir -p /var/log/fluxer && \
	chown -R root:root /usr/src/app/data && \
	chown -R root:root /opt/data && \
	chown -R root:root /data

# Bundle NSFW model by default so the monolith media-proxy starts without extra mounts.
RUN --mount=type=bind,from=build,source=/usr/src/app/fluxer_media_proxy/data/model.onnx,target=/tmp/model.onnx \
    cp /tmp/model.onnx /opt/data/model.onnx



EXPOSE 8080


ENV NODE_ENV=production

ENV FLUXER_SERVER_HOST=0.0.0.0
ENV FLUXER_SERVER_PORT=8080
ENV FLUXER_GATEWAY_HOST=127.0.0.1
ENV FLUXER_GATEWAY_PORT=8082
ENV DATABASE_BACKEND=sqlite
ENV SQLITE_PATH=/usr/src/app/data/db/fluxer.db
ENV STORAGE_ROOT=/usr/src/app/data/storage
ENV SEARCH_BACKEND=sqlite
ENV FLUXER_SERVER_STATIC_DIR=/usr/src/app/assets

ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_NUMBER=${BUILD_NUMBER}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV RELEASE_CHANNEL=${RELEASE_CHANNEL}

WORKDIR /usr/src/app/fluxer_server

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
	CMD curl -f http://localhost:8080/_health || exit 1

ENTRYPOINT ["pnpm", "start"]
