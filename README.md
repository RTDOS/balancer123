# AntiLag VPN Balancer & Manager (Production VPS Deploy Guide)

Высокопроизводительный серверный балансировщик VPN/Proxy подключений с анти-лаг системой (Gaming/Web Mode), защитной камуфляжной заглушкой (Nginx 404), секретным путем доступа и P2P-кластеризацией для 2-3 серверов.

---

## 🐙 Инструкция по загрузке в закрытый (Private) репозиторий GitHub

Выполните следующие команды в папке проекта:

```bash
# 1. Инициализация Git репозитория
git init

# 2. Добавление всех файлов
git add .
git commit -m "Initial commit of AntiLag VPN Balancer v1.4"

# 3. Привязка вашего закрытого репозитория GitHub
git remote add origin git@github.com:YOUR_USERNAME/YOUR_PRIVATE_REPO.git
git branch -M main
git push -u origin main
```

---

## 🚀 Варианты развертывания на Linux VPS сервере

### Вариант 1: Автоматический запуск через Docker / Docker Compose (Рекомендуемый)

```bash
# Клонирование из закрытого репозитория
git clone https://github.com/YOUR_USERNAME/YOUR_PRIVATE_REPO.git /var/www/projectbalance
cd /var/www/projectbalance

# Запуск контейнера в фоновом режиме
docker compose up -d --build
```

### Вариант 2: Запуск в качестве системной службы Systemd (1-Click script)

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_PRIVATE_REPO.git /var/www/projectbalance
cd /var/www/projectbalance

# Запуск автоинсталлятора
chmod +x deploy.sh
./deploy.sh
```

---

## 🔒 Доступ и порты

- 🎭 **Заглушка для сканеров (Nginx 404)**: `http://YOUR_SERVER_IP:8080/`
- 🗝️ **Секретная веб-панель**: `http://YOUR_SERVER_IP:8080/secret/`
- 🔀 **SOCKS5 Инбаунд**: `YOUR_SERVER_IP:1080`
- 🌐 **HTTP Инбаунд**: `YOUR_SERVER_IP:1081`

---

## ⚡ Особенности версии 1.4:
1. **Gaming Mode (Защита от вылетов из CS2, Valorant, Dota 2)**: Удерживает IP до последнего при мелких лагах.
2. **Web Fast Switch Mode**: Переключает трафик за ~50 мс при появлении джиттера.
3. **Nginx 404 Camouflage**: При вызове `/` маскируется под 404 Nginx server.
4. **HA Mesh Cluster**: Возможность связать 2–3 сервера для взаимного дублирования и P2P-синхронизации базы VPN.
