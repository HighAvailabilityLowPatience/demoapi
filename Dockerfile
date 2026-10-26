FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js apps.json ./
COPY src ./src
USER node
EXPOSE 9000
CMD ["node", "server.js"]
