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
CMD ["node", "dist/main.js"]
