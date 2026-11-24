# Sunucu sertleştirme kontrol listesi (VPS + Coolify)

Bir kez, Coolify'daki kaynaklardan önce. Ubuntu/Debian varsayılır; root ya
da sudo ile. Her maddenin sonunda kontrol komutu var. Hedef: dışarıdan
yalnızca **22, 80, 443** açık; Coolify paneli dahil her şey 443 arkasında.

## 1. SSH yalnızca anahtarla

```bash
# Önce anahtarla giriş yapabildiğinizi ikinci bir oturumda doğrulayın!
cat >/etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
EOF
sshd -t && systemctl reload ssh
```

Kontrol: `ssh -o PubkeyAuthentication=no <vps>` → `Permission denied (publickey)`.
Coolify sunucuya kendi anahtarıyla bağlanır (`/data/coolify/ssh/keys`);
`PermitRootLogin prohibit-password` onu bozmaz.

## 2. Güvenlik duvarı (ufw) — Docker'la birlikte

```bash
apt-get install -y ufw
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable
```

**Docker ufw'yi atlar**: `ports:` ile yayınlanan bir konteyner portu ufw'ye
rağmen dışarı açılır. Bu yüzden: Postgres "publicly available" **kapalı**,
API'de "Ports Mappings" **boş** (yalnızca "Ports Exposes" — Traefik iç ağdan
erişir). Kontrol dışarıdan yapılır (§7).

## 3. Coolify paneli 443 arkasında, 8000 kapalı

1. DNS: `coolify.<alan adı>` → VPS IP (A kaydı).
2. Coolify → Settings → **Instance's Domain**: `https://coolify.<alan adı>`
   → kaydet; Traefik sertifika alır.
3. Panel yeni adresten açılıyorsa 8000/6001/6002'yi dışarı kapatın. Coolify
   bu portları Docker ile yayınladığı için ufw yetmez; `DOCKER-USER`
   zincirine kural:

   ```bash
   # /etc/ufw/after.rules dosyasının SONUNA ekleyin:
   # *filter
   # :DOCKER-USER - [0:0]
   # -A DOCKER-USER -i <dış arayüz, ör. eth0> -p tcp -m conntrack --ctorigdstport 8000 -j DROP
   # -A DOCKER-USER -i <dış arayüz> -p tcp -m conntrack --ctorigdstport 6001 -j DROP
   # -A DOCKER-USER -i <dış arayüz> -p tcp -m conntrack --ctorigdstport 6002 -j DROP
   # COMMIT
   ufw reload
   ```

   (Alternatif: `/data/coolify/source/.env`'de `APP_PORT=127.0.0.1:8000`
   gibi yalnızca yerel yayın — Coolify güncellemesinde korunduğunu
   kontrol edin.)
4. Coolify → Settings → iki adımlı doğrulama (2FA) açık; kayıt (Registration)
   kapalı.

## 4. Otomatik güvenlik güncellemeleri

```bash
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades          # "Yes"
# Çekirdek güncellemesinden sonra yeniden başlatma: gece 04:30 TR
echo 'Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "01:30";' >/etc/apt/apt.conf.d/52mso-reboot
```

Kontrol: `unattended-upgrade --dry-run -d | tail`. Yeniden başlatmadan
sonra Coolify konteynerleri (`restart: unless-stopped`) kendiliğinden
kalkar; dış izleme (backup.md §4) kalkmazsa uyarır.

## 5. fail2ban (SSH)

```bash
apt-get install -y fail2ban
cat >/etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
bantime = 1h
EOF
systemctl enable --now fail2ban && fail2ban-client status sshd
```

API'nin kaba kuvvet sınırları uygulamanın içinde (S05/S06); fail2ban
yalnızca SSH içindir.

## 6. Docker log rotasyonu ve saat

```bash
cat >/etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
EOF
systemctl restart docker        # konteynerler yeniden başlar; bakım saatinde
timedatectl set-timezone UTC    # cron ve loglar UTC (DB de UTC)
timedatectl show -p NTPSynchronized   # yes
```

Var olan `daemon.json` varsa birleştirin (Coolify kendi ayarını yazmış
olabilir). Yeni ayar yalnızca yeniden oluşturulan konteynerlere uygulanır:
Coolify'dan bir kez Redeploy.

Journald: `/etc/systemd/journald.conf` → `SystemMaxUse=500M`.

## 7. Coolify'ın kendi güncellemeleri

Coolify → Settings → **Auto Update** kapalı; güncellemeyi bakım saatinde
elle yapın (Settings → Update), önce sürüm notlarına bakın. Güncellemeden
sonra §8 kontrollerini tekrarlayın (port yayınlarını geri açabilir).

## 8. Son kontrol (başka bir makineden)

```bash
nmap -Pn -p- --min-rate 2000 <VPS IP>      # yalnızca 22, 80, 443 open
curl -sI http://<VPS IP>:8000 --max-time 5  # zaman aşımı / reddedildi
ssh -o PubkeyAuthentication=no root@<VPS IP> # Permission denied (publickey)
```

Sonuç `PROGRESS.md` günlüğüne tarihle yazılır (S16 kabul kriteri).
