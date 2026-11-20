FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /opt/study-browser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --fund=false
COPY preflight.mjs runner.mjs spec.mjs packet.mjs sandbox.mjs compile.mjs ./
USER pwuser
WORKDIR /work
CMD ["node", "/opt/study-browser/runner.mjs"]
