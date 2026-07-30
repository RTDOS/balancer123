# AntiLag VPN Balancer & Manager (Production VPS Deploy Guide)

Высокопроизводительный серверный балансировщик VPN/Proxy подключений с анти-лаг системой (Gaming/Web Mode), защитной камуфляжной заглушкой (Nginx 404), генератором паролей администратора, защитой инбаундов авторизацией и P2P-кластеризацией для 2-3 серверов.

---

## 🔒 Безопасность и пароли (v1.5)

1. **Генератор паролей в 1 клик**:
   - В шапке панели кнопка **`🔐 Пароль & Доступ`** позволяет в 1 клик сгенерировать устойчивый 16-значный криптографический пароль.
2. **Защита SOCKS5 и HTTP прокси портов (1080 и 1081)**:
   - Включаемая галочка «Защитить SOCKS5 и HTTP прокси логином и паролем» закрывает сторонний доступ к порту прокси сервера (требует SOCKS5 User/Pass auth и HTTP 407 Proxy-Authorization).
3. **Заглушка для сканеров (Nginx 404)**:
   - При визите коренного URL `/` выдается полноценная камуфляжная страница 404 Nginx. Панель доступна только по секретному пути `/secret/`.

---

## 🐙 Загрузка в закрытый (Private) репозиторий GitHub

```bash
# 1. Инициализация Git репозитория
git init

# 2. Добавление всех файлов
git add .
git commit -m "AntiLag VPN Balancer v1.5 release"

# 3. Привязка вашего закрытого репозитория GitHub
git remote add origin git@github.com:YOUR_USERNAME/YOUR_PRIVATE_REPO.git
git branch -M main
git push -u origin main
```

---

## 🚀 Развертывание на Linux VPS сервере

### Вариант 1: Запуск через Docker Compose (Рекомендуемый)

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_PRIVATE_REPO.git /var/www/projectbalance
cd /var/www/projectbalance

docker compose up -d --build
```

### Вариант 2: Запуск в качестве системной службы Systemd (1-Click script)

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_PRIVATE_REPO.git /var/www/projectbalance
cd /var/www/projectbalance

chmod +x deploy.sh
./deploy.sh
```

---

## 🌐 Доступ и порты

- 🎭 **Заглушка (Nginx 404)**: `http://YOUR_SERVER_IP:8080/`
- 🗝️ **Секретная веб-панель**: `http://YOUR_SERVER_IP:8080/secret/`
- 🔀 **SOCKS5 Инбаунд**: `YOUR_SERVER_IP:1080` (с поддержкой Auth)
- 🌐 **HTTP Инбаунд**: `YOUR_SERVER_IP:1081` (с поддержкой Auth)
