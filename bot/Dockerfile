# Deno 2 is required, not a preference: bot/deno.lock is lockfile v5, which
# 1.x cannot read, and the npm: specifier for the Discord library resolves
# through Deno 2's npm compatibility layer. Pinned to the version the type
# check was run against.
FROM denoland/deno:2.9.5

WORKDIR /app
COPY bot ./bot
COPY shared ./shared

WORKDIR /app/bot
RUN deno cache src/main.ts

EXPOSE 9090
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "src/main.ts"]
