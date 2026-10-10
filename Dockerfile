# Juhandu runs TypeScript directly on Node, has no runtime npm dependencies, and needs no build step.
FROM node:26-alpine

# yt-dlp and ffmpeg are only needed to read videos from captions, audio, and frames. Build with --build-arg VIDEO_TOOLS=true to include them.
ARG VIDEO_TOOLS=false
RUN if [ "$VIDEO_TOOLS" = "true" ]; then apk add --no-cache yt-dlp ffmpeg; fi

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web

# The listener binds every interface inside the container. Publish the port on 127.0.0.1 only, as compose.yaml does, unless a proxy that authenticates sits in front.
ENV JUHANDU_HOST=0.0.0.0 \
    JUHANDU_PORT=8787 \
    JUHANDU_DATA=/data

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.JUHANDU_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/main.ts"]
