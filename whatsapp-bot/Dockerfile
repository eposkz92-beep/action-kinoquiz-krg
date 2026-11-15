FROM node:22-alpine

WORKDIR /app

# Install tzdata for proper Kazakhstan (Asia/Almaty) timezone support
RUN apk add --no-cache tzdata
ENV TZ=Asia/Almaty

# Copy dependency files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Expose Web QR Dashboard port
EXPOSE 3000

# Mountable persistent storage volumes
VOLUME ["/app/auth_info_baileys", "/app/data", "/app/exports"]

# Start WhatsApp Bot
CMD ["node", "src/index.js"]
