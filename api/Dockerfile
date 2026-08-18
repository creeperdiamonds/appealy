FROM node:20-alpine AS build
WORKDIR /app
COPY api/package.json api/package-lock.json* ./api/
COPY shared ./shared
WORKDIR /app/api
RUN npm install
COPY api ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/api/dist ./dist
COPY --from=build /app/api/node_modules ./node_modules
COPY --from=build /app/shared ./shared
EXPOSE 3001
# dist/api/src/main.js, not dist/main.js: tsconfig sets rootDir ".." so that
# shared/ can be compiled alongside src/, and tsc mirrors that layout under
# outDir. The old path did not exist and the container exited immediately with
# MODULE_NOT_FOUND.
CMD ["node", "dist/api/src/main.js"]
