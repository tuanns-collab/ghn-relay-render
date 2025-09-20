FROM node:20-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json* /app/
RUN npm ci
COPY server.js /app/
CMD ["npm","start"]
