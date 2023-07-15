FROM node:20-alpine
WORKDIR /app
ADD *.js .
ADD *.json .
RUN npm install
EXPOSE 3000
ENV PORT=3000
ENV EPISODE_LIMIT=20
ENTRYPOINT ["./index.js"]
