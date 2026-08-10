# web/Dockerfile
# Two stages: build with Node, serve the static output with nginx. The
# console is a static bundle — it holds no secrets and talks to the API
# over the same session cookie a browser would send anyway, so there is no
# reason to keep a Node process alive to serve it.

FROM node:20-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
# Baked at build time, since Vite inlines env vars into the bundle.
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
