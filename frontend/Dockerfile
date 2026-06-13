# Build the React app, then serve it behind nginx with the reverse proxy.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# self-signed TLS cert so the browser grants microphone access over https
RUN apk add --no-cache openssl && mkdir -p /etc/nginx/certs && \
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout /etc/nginx/certs/self.key -out /etc/nginx/certs/self.crt \
      -subj "/CN=myno" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80 443
