#!/usr/bin/env bash

# =================================================================
# ⚡ AntiLag VPN Balancer & Manager - 1-Click Bash Installer ⚡
# Repository: https://github.com/RTDOS/balancer123
# Auto Dependency Installer, Systemd Service, Firewall & SSH Tunnel Mode
# =================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

echo -e "${CYAN}"
echo "======================================================="
echo "⚡ AntiLag VPN Balancer & Manager - 1-Click Installer ⚡"
echo "======================================================="
echo -e "${NC}"

# Check root privileges
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}❌ Пожалуйста, запустите скрипт с правами root (sudo bash install.sh)${NC}"
  exit 1
fi

INSTALL_DIR="/opt/antilag"
PUBLIC_IP=$(curl -s --max-time 3 https://api.ipify.org || curl -s --max-time 3 https://ifconfig.me || echo "YOUR_SERVER_IP")

echo -e "${YELLOW}🔍 [1/5] Проверка и автоматическая установка зависимостей...${NC}"

# Detect package manager
PKG_MANAGER=""
if command -v apt-get &> /dev/null; then
  PKG_MANAGER="apt"
  apt-get update -qq || true
  apt-get install -y -qq curl wget git tar unzip ufw iptables &> /dev/null || true
elif command -v dnf &> /dev/null; then
  PKG_MANAGER="dnf"
  dnf install -y -q curl wget git tar unzip iptables ufw &> /dev/null || true
elif command -v yum &> /dev/null; then
  PKG_MANAGER="yum"
  yum install -y -q curl wget git tar unzip iptables &> /dev/null || true
elif command -v pacman &> /dev/null; then
  PKG_MANAGER="pacman"
  pacman -Sy --noconfirm curl wget git tar unzip iptables &> /dev/null || true
fi

# Check Node.js version (Requires v18+)
NEED_NODE=false
if command -v node &> /dev/null; then
  NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VER" -lt 18 ]; then
    NEED_NODE=true
  fi
else
  NEED_NODE=true
fi

if [ "$NEED_NODE" = true ]; then
  echo -e "${YELLOW}⚙️ Установка официального Node.js 20 LTS...${NC}"
  if [ "$PKG_MANAGER" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &> /dev/null
    apt-get install -y nodejs &> /dev/null
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - &> /dev/null
    yum install -y nodejs &> /dev/null || dnf install -y nodejs &> /dev/null
  fi
fi

echo -e "${GREEN}✅ Все зависимости укомплектованы: Node.js $(node -v), npm $(npm -v)${NC}"

# Install sing-box helper binary for TUIC v5 QUIC inbounds
SINGBOX_BIN="/opt/antilag/bin/sing-box"
if [ ! -f "$SINGBOX_BIN" ]; then
  echo -e "${YELLOW}⚙️ Установка официального ядра sing-box (TUIC v5 / QUIC TLS 1.3)...${NC}"
  mkdir -p /opt/antilag/bin
  ARCH=$(uname -m)
  if [ "$ARCH" = "x86_64" ]; then
    SB_ARCH="amd64"
  elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    SB_ARCH="arm64"
  else
    SB_ARCH="amd64"
  fi

  URL="https://github.com/SagerNet/sing-box/releases/download/v1.9.3/sing-box-1.9.3-linux-${SB_ARCH}.tar.gz"
  curl -sSL "$URL" -o /tmp/singbox.tar.gz && \
  tar -xzf /tmp/singbox.tar.gz -C /tmp && \
  cp /tmp/sing-box-1.9.3-linux-${SB_ARCH}/sing-box "$SINGBOX_BIN" && \
  chmod +x "$SINGBOX_BIN" &> /dev/null || true
  rm -rf /tmp/singbox* &> /dev/null || true
  echo -e "${GREEN}✅ sing-box ядро успешно установлено: /opt/antilag/bin/sing-box${NC}"
fi

echo -e "\n${CYAN}=======================================================${NC}"
echo -e "${PURPLE}🛠️ [2/5] Выберите режим работы панели управления:${NC}"
echo -e "${CYAN}=======================================================${NC}"
echo -e "1) ${GREEN}🌐 Прямой доступ (0.0.0.0:8080)${NC}"
echo -e "   Панель доступна по публичному IP сервера в браузере."
echo -e "   Защищена Secret Path (/secret/) + Паролем панели + Anti-BruteForce.\n"
echo -e "2) ${YELLOW}🔒 Сверхзащищенный SSH-Туннель (127.0.0.1:8080)${NC}"
echo -e "   Панель слушает исключительно локальный адрес и НЕВИДИМА для сканеров."
echo -e "   Подключение происходит через SSH-туннель: ssh -L 8080:127.0.0.1:8080 root@${PUBLIC_IP}\n"

# Auto-detect existing systemd configuration mode if upgrading!
AUTO_MODE=""
if [ -f "/etc/systemd/system/antilag.service" ]; then
  if grep -q "127.0.0.1" /etc/systemd/system/antilag.service; then
    AUTO_MODE="2"
  elif grep -q "0.0.0.0" /etc/systemd/system/antilag.service; then
    AUTO_MODE="1"
  fi
fi

if [ "$1" = "--auto" ] || [ -n "$AUTO_MODE" ]; then
  BIND_CHOICE="${AUTO_MODE:-1}"
  echo -e "${GREEN}ℹ️ Обнаружен существующий режим работы (${BIND_CHOICE}). Автоматическое применение...${NC}"
else
  # Force input reading from TTY for fresh installation!
  if [ -t 0 ]; then
    read -p "Введите номер режима [1 или 2] (По умолчанию 1): " BIND_CHOICE
  else
    read -p "Введите номер режима [1 или 2] (По умолчанию 1): " BIND_CHOICE < /dev/tty || BIND_CHOICE="1"
  fi
fi

if [ "$BIND_CHOICE" = "2" ]; then
  BIND_HOST="127.0.0.1"
  MODE_NAME="SSH Tunnel Mode (127.0.0.1)"
else
  BIND_HOST="0.0.0.0"
  MODE_NAME="Direct Web Access (0.0.0.0)"
fi

echo -e "${GREEN}Выбран режим: ${MODE_NAME}${NC}"

echo -e "\n${YELLOW}📦 [3/5] Развертывание исходного кода AntiLag (RTDOS/balancer123)...${NC}"
mkdir -p "$INSTALL_DIR"

if [ -f "$INSTALL_DIR/config.json" ]; then
  cp "$INSTALL_DIR/config.json" /tmp/config.json.bak &> /dev/null || true
fi

if [ -f "./package.json" ]; then
  cp -r ./* "$INSTALL_DIR/" &> /dev/null || true
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    git stash &> /dev/null || true
    git checkout -- . &> /dev/null || true
    git pull origin main || git pull || true
  else
    rm -rf "$INSTALL_DIR"
    git clone https://github.com/RTDOS/balancer123.git "$INSTALL_DIR" || cp -r . "$INSTALL_DIR"
  fi
fi

if [ -f "/tmp/config.json.bak" ]; then
  cp /tmp/config.json.bak "$INSTALL_DIR/config.json" &> /dev/null || true
  rm -f /tmp/config.json.bak &> /dev/null || true
fi

cd "$INSTALL_DIR"

# Write environment config
cat <<EOF > "$INSTALL_DIR/.env"
PORT=8080
HOST=${BIND_HOST}
EOF

echo -e "${YELLOW}⚙️ Установка npm пакетов...${NC}"
npm install --production

echo -e "\n${YELLOW}⚙️ [4/5] Настройка системной службы Systemd & Фаервола...${NC}"

# Create Systemd Service
cat <<EOF > /etc/systemd/system/antilag.service
[Unit]
Description=AntiLag VPN Balancer & Manager Engine
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=${INSTALL_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable antilag.service &> /dev/null
systemctl restart antilag.service

# Configure Firewall
if command -v ufw &> /dev/null; then
  ufw allow 1080/tcp &> /dev/null || true
  ufw allow 1081/tcp &> /dev/null || true
  if [ "$BIND_HOST" = "0.0.0.0" ]; then
    ufw allow 8080/tcp &> /dev/null || true
  fi
elif command -v iptables &> /dev/null; then
  iptables -A INPUT -p tcp --dport 1080 -j ACCEPT &> /dev/null || true
  iptables -A INPUT -p tcp --dport 1081 -j ACCEPT &> /dev/null || true
  if [ "$BIND_HOST" = "0.0.0.0" ]; then
    iptables -A INPUT -p tcp --dport 8080 -j ACCEPT &> /dev/null || true
  fi
fi

# Create global helper script /usr/local/bin/antilag
cat <<'EOF' > /usr/local/bin/antilag
#!/usr/bin/env bash

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

IP=$(curl -s --max-time 3 https://api.ipify.org || echo "YOUR_SERVER_IP")
ENV_FILE="/opt/antilag/.env"
HOST_VAL=$(grep "HOST=" $ENV_FILE | cut -d'=' -f2 || echo "0.0.0.0")

show_menu() {
  echo -e "${CYAN}=======================================================${NC}"
  echo -e "${GREEN}⚡ Управление службой AntiLag Router & Balancer ⚡${NC}"
  echo -e "${CYAN}=======================================================${NC}"
  echo -e "1) 📊 Статус службы и ссылки доступа"
  echo -e "2) 🔒 Показать команду SSH-Туннеля"
  echo -e "3) 🔄 Перезапустить AntiLag"
  echo -e "4) 📜 Посмотреть логи в реальном времени (journalctl)"
  echo -e "5) 🔀 Переключить режим (Public 0.0.0.0 <-> SSH 127.0.0.1)"
  echo -e "6) 🔑 Сбросить пароль, логин и секретный путь (admin / admin / /secret/)"
  echo -e "7) 🛑 Остановить службу"
  echo -e "0) Выход\n"

  if [ -t 0 ]; then
    read -p "Выберите действие [0-7]: " choice
  else
    read -p "Выберите действие [0-7]: " choice < /dev/tty
  fi

  case $choice in
    1)
      systemctl status antilag --no-pager
      if ! systemctl is-active --quiet antilag; then
        echo -e "\n${RED}⚠️ Ошибка запуска службы! Чтение последних логов:${NC}"
        journalctl -u antilag -n 15 --no-pager
      fi

      echo -e "\n${GREEN}👉 Ссылка на веб-панель:${NC}"
      if [ "$HOST_VAL" = "127.0.0.1" ]; then
        echo -e "🔒 Режим SSH Туннеля: http://localhost:8080/secret/"
        echo -e "Сначала выполните в консоли ПК: ssh -L 8080:127.0.0.1:8080 root@${IP}"
      else
        echo -e "🌐 http://${IP}:8080/secret/"
      fi
      ;;
    2)
      echo -e "${YELLOW}Скопируйте и выполните эту команду на вашем ПК в PowerShell / Терминале:${NC}"
      echo -e "${GREEN}ssh -L 8080:127.0.0.1:8080 root@${IP}${NC}"
      echo -e "Затем откройте в браузере: ${CYAN}http://localhost:8080/secret/${NC}"
      ;;
    3)
      systemctl restart antilag
      echo -e "${GREEN}✅ Служба AntiLag успешно перезапущена!${NC}"
      ;;
    4)
      journalctl -u antilag -f -n 50
      ;;
    5)
      if [ "$HOST_VAL" = "127.0.0.1" ]; then
        sed -i 's/HOST=127.0.0.1/HOST=0.0.0.0/' $ENV_FILE
        echo -e "${GREEN}Режим изменен на 🌐 Прямой доступ (0.0.0.0:8080)${NC}"
      else
        sed -i 's/HOST=0.0.0.0/HOST=127.0.0.1/' $ENV_FILE
        echo -e "${YELLOW}Режим изменен на 🔒 Сверхзащищенный SSH-Туннель (127.0.0.1:8080)${NC}"
      fi
      systemctl restart antilag
      ;;
    6)
      echo -e "${YELLOW}🔑 Сброс учетных данных веб-панели AntiLag...${NC}"
      CONFIG_FILE="/opt/antilag/config.json"
      if [ -f "$CONFIG_FILE" ]; then
        node -e '
          const fs = require("fs");
          const p = "/opt/antilag/config.json";
          if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, "utf-8"));
            data.adminUsername = "admin";
            data.adminPassword = "admin";
            data.isDefaultPassword = true;
            data.secretPath = "secret";
            fs.writeFileSync(p, JSON.stringify(data, null, 2));
          }
        ' &> /dev/null || true
        systemctl restart antilag
        echo -e "${GREEN}✅ Учетные данные успешно сброшены!${NC}"
        echo -e "👤 Логин: ${CYAN}admin${NC}"
        echo -e "🔑 Пароль: ${CYAN}admin${NC}"
        echo -e "🔒 Секретный путь: ${CYAN}/secret/${NC}"
      else
        echo -e "${RED}Файл config.json не найден.${NC}"
      fi
      ;;
    7)
      systemctl stop antilag
      echo -e "${RED}🛑 Служба AntiLag остановлена.${NC}"
      ;;
    0)
      exit 0
      ;;
    *)
      echo "Неверный выбор."
      ;;
  esac
}

show_menu
EOF

chmod +x /usr/local/bin/antilag

echo -e "\n${CYAN}=======================================================${NC}"
echo -e "${GREEN}🎉 [5/5] AntiLag VPN Balancer успешно установлен и запущен!${NC}"
echo -e "${CYAN}=======================================================${NC}"

if [ "$BIND_HOST" = "127.0.0.1" ]; then
  echo -e "${YELLOW}🔒 Выбран режим Сверхзащищенного SSH-Туннеля (127.0.0.1:8080)${NC}"
  echo -e "Для доступа к веб-панели выполните на вашем ПК:"
  echo -e "${GREEN}👉 ssh -L 8080:127.0.0.1:8080 root@${PUBLIC_IP}${NC}"
  echo -e "Затем откройте в браузере:"
  echo -e "${CYAN}👉 http://localhost:8080/secret/${NC}"
else
  echo -e "${GREEN}🌐 Выбран режим Прямого доступа (0.0.0.0:8080)${NC}"
  echo -e "Ссылка для входа в веб-панель:"
  echo -e "${CYAN}👉 http://${PUBLIC_IP}:8080/secret/${NC}"
  echo -e "Заглушка для сканеров (Nginx 404): http://${PUBLIC_IP}:8080/"
fi

echo -e "\n🔑 Стандартные данные для первого входа: ${YELLOW}admin / admin${NC}"
echo -e "💡 Команда управления службой из консоли: ${GREEN}antilag${NC}\n"
