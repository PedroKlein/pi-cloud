FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build

# Sessions of the server's own runner use git, and Pi installs npm packages.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/apps/pipoca/dist/pipoca /usr/local/bin/pipoca
RUN mkdir /data && chown node:node /data
USER node
ENV HOME=/data
WORKDIR /data
EXPOSE 7420
ENTRYPOINT ["pipoca", "server", "--host", "0.0.0.0", "--database", "/data/server.db"]
