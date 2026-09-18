FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY capture.js ./

ENV NODE_ENV=production

CMD ["npm", "start"]
