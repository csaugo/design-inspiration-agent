FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/public
CMD ["node", "src/worker.js"]
