# Renderer Lambda container image: Node 22 + FFmpeg.
#
# Why a container image and not a layer: the FFmpeg build plus the bundled font
# comfortably exceeds the Lambda layer limits once you want a full filter set.
# Why Lambda and not Fargate: see docs/decisions.md for the thresholds at which
# that trade flips.

# ----------------------------------------------------------------- ffmpeg
FROM public.ecr.aws/lambda/nodejs:22 AS ffmpeg

# A static FFmpeg build is fetched at image-build time rather than vendored into
# git. Override with --build-arg if your organisation mirrors its own build.
#
# NOTE ON LICENSING: common static builds are GPL-licensed. That is fine for a
# binary you run yourself and do not redistribute. If you intend to redistribute
# this image, use an LGPL build or compile FFmpeg yourself. Record whichever you
# use in docs/decisions.md.
ARG FFMPEG_URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz

RUN dnf install -y tar xz && dnf clean all
RUN mkdir -p /ffmpeg \
 && curl -fsSL "${FFMPEG_URL}" -o /tmp/ffmpeg.tar.xz \
 && tar -xJf /tmp/ffmpeg.tar.xz -C /ffmpeg --strip-components=1 \
 && rm /tmp/ffmpeg.tar.xz \
 && /ffmpeg/ffmpeg -version

# ------------------------------------------------------------------ build
FROM public.ecr.aws/lambda/nodejs:22 AS build

WORKDIR /build
COPY package.json package-lock.json ./
COPY services/shared/package.json ./services/shared/
COPY services/providers/package.json ./services/providers/
COPY services/handlers/package.json ./services/handlers/
COPY renderer/package.json ./renderer/
COPY infra/package.json ./infra/

RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY services ./services
COPY renderer ./renderer

# Bundle to single ESM files so the runtime image carries no node_modules.
# Two entrypoints share one image: the render function and the ffprobe-based
# validator. The CDK stack selects between them with the container CMD.
RUN npx esbuild renderer/src/handler.ts renderer/src/validate-handler.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --outdir=/build/dist \
      --out-extension:.js=.mjs \
      --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"

# --------------------------------------------------------------- runtime
FROM public.ecr.aws/lambda/nodejs:22

COPY --from=ffmpeg /ffmpeg/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffmpeg/ffprobe /usr/local/bin/ffprobe
COPY --from=build /build/dist/handler.mjs ${LAMBDA_TASK_ROOT}/handler.mjs
COPY --from=build /build/dist/validate-handler.mjs ${LAMBDA_TASK_ROOT}/validate-handler.mjs

# Fonts are fetched by `npm run fonts:fetch` before the image build and baked in
# here. The licence file travels with them.
COPY renderer/fonts /opt/fonts

ENV FFMPEG_PATH=/usr/local/bin/ffmpeg \
    FFPROBE_PATH=/usr/local/bin/ffprobe \
    FONT_DIR=/opt/fonts \
    NODE_OPTIONS=--enable-source-maps

# Overridden to ["validate-handler.handler"] for the validator function.
CMD ["handler.handler"]
