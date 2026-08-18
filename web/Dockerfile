# web/Dockerfile
# Two stages: build with Node, serve the static output with nginx. The console
# is a static bundle — it holds no secrets and talks to the API over the same
# session cookie a browser would send anyway, so there is no reason to keep a
# Node process alive to serve it.

# Node 24 (LTS "Krypton"), matching api/Dockerfile. Only the build stage runs
# Node; the image that ships is nginx serving a static bundle.
FROM node:24-alpine AS build
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
#
# Empty by default, and that is the correct value for every normal deployment:
# nginx in the runtime stage proxies /auth/ and /api/ to the API, so the bundle
# calls them as same-origin relative paths and the session cookie stays
# first-party. See web/nginx.conf for why that matters.
#
# Set it to an absolute URL only if you are deliberately serving the console
# and the API as separate origins — in which case the cookie will not be sent
# unless both are on the same registrable domain.
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine

# Cloud Run injects PORT and expects the container to listen on it. nginx
# can't read an env var in a config file directly, so the template is
# substituted at container start. Defaults to 8080, which is Cloud Run's
# default, and works unchanged under docker-compose.
ENV PORT=8080

# Where nginx forwards /auth/ and /api/. Runtime config, not build-time: unlike
# VITE_API_URL this is read by nginx at container start, so the same image can
# be pointed at a different API without a rebuild.
#
# The compose default reaches the api service over the internal network. On
# Cloud Run set it to the API service's https URL.
ENV API_ORIGIN=http://api:3001

# nginx needs an explicit resolver to do runtime DNS for a proxy_pass built
# from a variable. 127.0.0.11 is Docker's embedded DNS, which is what compose
# needs; on Cloud Run the backend is a public *.run.app name, so override this
# with a public resolver (the deploy workflow sets 169.254.169.254, the GCP
# metadata server).
ENV DNS_RESOLVER=127.0.0.11

COPY web/nginx.conf /etc/nginx/templates/default.conf.template
COPY web/appealy-proxy.conf /etc/nginx/appealy-proxy.conf

# Three things share one document root, and the layout is what the location
# blocks in nginx.conf assume:
#
#   /            the marketing site — static, no build step, and the only part
#                a logged-out visitor can see
#   /dashboard/  the console bundle, which is why vite sets base to match
#   /status/     the shard status page, deliberately independent of both so it
#                still answers when the app is down
COPY site /usr/share/nginx/html
COPY status /usr/share/nginx/html/status
COPY --from=build /app/web/dist /usr/share/nginx/html/dashboard
EXPOSE 8080
