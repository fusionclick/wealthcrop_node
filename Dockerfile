FROM node:22-alpine

WORKDIR /app

# tgz pehle — bse-starmfv2-sdk package.json mein "file:" dependency hai
COPY package.json package-lock.json bse-starmfv2-sdk-1.0.0.tgz ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "src/index.js"]
