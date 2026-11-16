FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

WORKDIR /app
COPY LICENSE package.json ./
COPY bin/recall-mcp.js ./bin/
COPY src/ ./src/
RUN mkdir -m 0555 /memory

USER node
CMD ["node", "bin/recall-mcp.js", "--dir", "/memory", "--read-only"]
