#!/bin/bash
set -e

echo "🚀 Установка AntiLag VPN Balancer на Linux VPS..."

# Install Node.js if missing
if ! command -v node &> /dev/null; then
    echo "📦 Установка Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install dependencies
echo "📥 Установка npm зависимостей..."
npm install --production

# Create systemd service
echo "⚙️ Создание службы systemd..."
sudo cp projectbalance.service /etc/systemd/system/projectbalance.service
sudo systemctl daemon-reload
sudo systemctl enable projectbalance
sudo systemctl restart projectbalance

echo "===================================================="
echo "✅ Установка завершена!"
echo "👉 Камуфляж (Nginx 404): http://YOUR_SERVER_IP:8080"
echo "👉 Секретная панель: http://YOUR_SERVER_IP:8080/secret/"
echo "👉 SOCKS5: YOUR_SERVER_IP:1080 | HTTP: YOUR_SERVER_IP:1081"
echo "===================================================="
