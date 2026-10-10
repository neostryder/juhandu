# Juhandu runs TypeScript directly on Node, has no runtime npm dependencies, and needs no build step.
FROM node:26-alpine

# Video reading uses outside programs, and VIDEO_TOOLS picks which ones go into the image:
#   captions (the default) adds yt-dlp, so a video's own captions can be read. It adds about 22 MB to the download.
#   full also adds ffmpeg, so speech and frames can be read when a video has no captions. It adds about 125 MB.
#   none adds neither, and only the Gemini way of reading videos works.
# Sites change often and an old yt-dlp stops working, so rebuild the image with --no-cache now and then to update it.
ARG VIDEO_TOOLS=captions
RUN case "$VIDEO_TOOLS" in \
      full|true) apk add --no-cache yt-dlp ffmpeg ;; \
      captions) apk add --no-cache yt-dlp-core ;; \
      none|false) ;; \
      *) echo "VIDEO_TOOLS must be captions, full, or none" >&2; exit 1 ;; \
    esac

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
