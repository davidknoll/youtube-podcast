FROM node:20-alpine
RUN apk add --update-cache ffmpeg

WORKDIR /app
ADD *.json .
RUN npm install
ADD *.js .

EXPOSE 3000
ENV DEBUG=0
ENV PORT=3000
ENV CACHE_DIR=/cache
ENV EPISODE_LIMIT=20
VOLUME /cache

ENTRYPOINT ["./index.js"]
