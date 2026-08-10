FROM denoland/deno:1.45.5

WORKDIR /app
COPY bot ./bot
COPY shared ./shared

WORKDIR /app/bot
RUN deno cache src/main.ts

EXPOSE 9090
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "src/main.ts"]
