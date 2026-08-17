# web/Dockerfile
# Two stages: build with Node, serve the static output with nginx. The console
# is a static bundle — it holds no secrets and talks to the API over the same
# session cookie a browser would send anyway, so there is no reason to keep a
# Node process alive to serve it.

FROM node:20-alpine AS build
WORKDIR /app

# Deps first, so a source change doesn't reinstall node_modules.
COPY web/package.json web/package-lock.json* ./web/
WORKDIR /app/web
RUN npm install

WORKDIR /app
# `shared` is REQUIRED, not optional. web/src imports types from
# ../../../shared/schema/platformBans (the ban screen and the API client), so
# a build without it fails at type resolution with a module-not-found that
# points at a path the Dockerfile never created. Previously this directory was
# missing and the image simply couldn't build.
COPY shared ./shared
COPY web ./web

WORKDIR /app/web
# Baked at build time, since Vite inlines env vars into the bundle. Changing
# this later means rebuilding the image, not restarting the container.
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine

# Cloud Run injects PORT and expects the container to listen on it. nginx
# can't read an env var in a config file directly, so the template is
# substituted at container start. Defaults to 8080, which is Cloud Run's
# default, and works unchanged under docker-compose.
ENV PORT=8080
COPY web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
