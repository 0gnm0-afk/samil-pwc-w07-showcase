FROM node:24-alpine
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY app/ ./
ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
