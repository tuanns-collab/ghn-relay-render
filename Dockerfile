FROM node:20-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# 1) copy package.json trước để tận dụng cache
COPY package.json /app/

# 2) cài dependencies
RUN npm install

# 3) copy phần code còn lại
COPY server.js /app/

# 4) cài Chromium + deps cho Playwright (đặt ở Dockerfile để nhìn log rõ ràng)
RUN npx playwright install --with-deps chromium

# 5) start
CMD ["node","server.js"]
