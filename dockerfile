FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
EXPOSE 3001 3002 3003 4000
CMD ["npx", "ts-node", "src/start-all.ts"]