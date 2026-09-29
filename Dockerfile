FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
COPY docs/connect.md ./docs/connect.md
ENV CORPUS_DATA=/data/corpus
EXPOSE 4173
CMD ["node", "--no-warnings", "server.mjs"]
