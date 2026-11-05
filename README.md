# Approval MCP

Schvalovací brána mezi AI agentem a vašimi MCP servery. Určete, které nástroje
může agent používat přímo, které musí nejprve schválit člověk a které nesmí
používat vůbec. Rozhodnutí, oprávnění i průběh volání najdete ve webové aplikaci.

```text
MCP klient → Approval MCP → vaše MCP servery
                 ↕
          webové schvalování
          + push notifikace
```

## Ukázka

[![Schválení celého nástroje na hodinu](docs/media/approval-mcp-demo.png)](docs/media/approval-mcp-demo.webm)

[Přehrát krátké video (WebM)](docs/media/approval-mcp-demo.webm)

Video ukazuje upstreamy, profily, schválení zprávy, hodinové oprávnění bez
omezení na příjemce, historii a seznam notifikačních zařízení. Používá pouze
ukázková data; nic se neposílá do skutečného WhatsAppu ani push služby.
[Scénář a opakované natočení](docs/demo.md).

## Co umí

- **Profily přístupu:** povolit, vyžádat schválení nebo zakázat celý upstream
  či jednotlivé tooly. Nezkonfigurované nástroje zůstávají skryté.
- **Čitelná schválení:** pluginy zobrazují zprávu, kontakt, chat, událost nebo
  rezervaci; technické argumenty lze rozbalit.
- **Dočasná oprávnění:** povolit jednou, opakovaně pro konkrétní rozsah nebo
  na hodinu celý tool s libovolnými parametry. Trvalé schválení je dostupné
  u podporovaných rozsahů. Aktivní oprávnění lze kdykoli zrušit.
- **OAuth a passkeys:** klient otevře autorizační stránku; zvolíte jméno
  agenta, profil i dobu přístupu a potvrdíte passkey. Podporované jsou také
  ručně vytvořené agentní tokeny.
- **Web Push:** upozornění s odkazem na detail schválení a správa zařízení
  včetně tlačítka Test a odebrání zařízení.
- **Historie:** průběh volání, rozhodnutí, důvody zamítnutí a export JSONL/CSV.
- **Živý katalog:** obnova toolů za běhu, bez restartu serveru.
- **České a anglické GUI**, světlý i tmavý motiv a mobilní rozložení.

## Rychlý start v Dockeru

Potřebujete Docker a prohlížeč s podporou passkeys. Pro první lokální spuštění
použijte `http://localhost:43127`; vzdálené nasazení má používat HTTPS.

```bash
git clone https://github.com/jiridudekusy/approval-mcp-wrapper.git
cd approval-mcp-wrapper
cp .env.example .env
openssl rand -base64 32
```

Do `.env` vložte vygenerovaný klíč jako `APPROVAL_MCP_MASTER_KEY`. Tento klíč
uchovejte i pro další spuštění: šifruje upstream credentials a data Web Push.
Soubor `.env` nepatří do Gitu.

```bash
docker build -t approval-mcp-wrapper:local .
docker volume create approval-mcp-data
docker run -d \
  --name approval-mcp \
  --restart unless-stopped \
  --env-file .env \
  --publish 127.0.0.1:43127:3000 \
  --mount source=approval-mcp-data,target=/data \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  approval-mcp-wrapper:local
```

Otevřete [localhost:43127](http://localhost:43127) a pokračujte pomocí passkey.
Při prvním přihlášení se vytvoří správce. Passkey je vázaná na přihlašovací
hostname, proto pro další používání zvolte stabilní adresu serveru.

Volume `approval-mcp-data` a stejný master key zachovají nastavení, aktivní
oprávnění a registrace push zařízení při výměně image. Při aktualizaci datový
volume nemažte. Rozpracovaná čekající volání se při restartu přeruší.

Po úspěšné CI pipeline se image publikuje také jako
`ghcr.io/jiridudekusy/approval-mcp-wrapper:latest` pro `linux/amd64` a
`linux/arm64`. Dostupná registry image nemusí obsahovat dosud nepublikované
lokální commity; výše uvedený build sestaví právě váš checkout.

## První nastavení

1. V **Upstreamy** přidejte Streamable HTTP adresu svého MCP serveru.
   Doplňte alias, název, popis, případné credentials a prezentační plugin.
   Metadata mohou odlišit například pracovní a soukromý e-mail.
2. Použijte **Načíst tooly**. Pro úmyslné připojení do lokální nebo privátní
   sítě zapněte povolení privátních adres.
3. V **Přístupy → Profily** nastavte pravidla. Začněte čtecími nástroji;
   citlivým operacím dejte **Vyžádat schválení**. Ve stejném profilu nastavíte
   zvlášť čekání na schválení a timeout běhu nástroje; výchozí hodnota obou
   je 60 sekund.
4. Připojte MCP klienta přes OAuth nebo vytvořte agenta v **Přístupy** a
   zkopírujte jeho jednorázově zobrazený token.
5. Volání vyžadující schválení se objeví v **Ke schválení** a následně
   v **Historii**. V **Systém** si můžete zapnout notifikace.

### Připojení MCP klienta

Pro OAuth klientovi předejte HTTP MCP endpoint bez ručního tokenu:

```json
{
  "mcpServers": {
    "approval": {
      "type": "http",
      "url": "http://localhost:43127/mcp"
    }
  }
}
```

Přesný formát konfigurace závisí na klientovi. Při autorizaci v prohlížeči
zvolíte profil, jméno agenta a platnost přístupu. Přihlášení klienta samo
neschvaluje jeho jednotlivé tool calls.

Pro ručně vytvořeného agenta doplňte HTTP hlavičku
`Authorization: Bearer <token-agenta>`. Token neposílejte do veřejných
konfigurací ani logů.

`localhost` vždy označuje počítač nebo kontejner daného klienta. Pokud agent
běží jinde, použijte dosažitelnou HTTPS adresu serveru a nakonfigurujte
odpovídající OAuth origin. Callback OAuth musí být dosažitelný z počítače,
na kterém se otevře přihlašovací prohlížeč.
[Více adres a reverse proxy](docs/operations/deployment.md).

### Hodina bez omezení na scope

V detailu schválení vyberte **Celý nástroj (libovolné parametry)** a poté
**Povolit na 1 hodinu**. Oprávnění platí pro stejného agenta, upstream a tool,
ale neomezuje chat, příjemce ani jiné argumenty. Funguje i u pluginů bez
navrženého rozsahu. Po expiraci se opět vyžádá schválení; oprávnění lze
předčasně zrušit v **Přístupy → Aktivní oprávnění**.

Explicitní zákazy a viditelnost toolů podle profilu platí dál. Tato volba
nenabízí neomezené trvalé oprávnění.

### Notifikace

V **Systém** zařízení pojmenujte a povolte notifikace. U každého zařízení
můžete odeslat test nebo ho odebrat. Kliknutí na upozornění otevírá detail
požadavku; rozhodnutí proběhne v přihlášené webové aplikaci.

Pro vzdálený přístup používejte stabilní HTTPS adresu. Na iOS/iPadOS přidejte
web na plochu a notifikace zapněte z nainstalované webové aplikace. Obsah push
zprávy je obecné upozornění s ID a odkazem; argumenty toolu ani obsah zpráv
se do push payloadu nevkládají. Zobrazení upozornění a případných systémových
akcí závisí na zařízení a prohlížeči.

## Lokální běh bez Dockeru

Potřebujete Node.js 24 a npm. Použijte stejný `.env` jako v rychlém startu.

```bash
npm ci
npm run build
mkdir -p .local-data
HOST=127.0.0.1 PORT=43127 \
APPROVAL_MCP_DATA_DIR="$PWD/.local-data" \
node --env-file=.env apps/server/dist/main.js
```

Web i MCP endpoint běží na stejném portu. Pro kontrolu změn spusťte
`npm run verify`: typová kontrola, testy, produkční build, audit runtime
závislostí a kontrola jazykových katalogů.

Bezpečný testovací upstream najdete v
[pocs/approval-test-mcp](pocs/approval-test-mcp/README.md); jeho deploy tool
nasazení pouze simuluje.

## Provoz a další dokumentace

| Téma | Dokumentace |
| --- | --- |
| HTTPS, konfigurace, OAuth adresy, persistentní data | [Nasazení](docs/operations/deployment.md) |
| Zálohy a přenos dat | [Zálohování](docs/operations/backup-and-restore.md) |
| Obnova dat po havárii | [Obnova](docs/operations/disaster-recovery.md) |
| Protokol, OAuth a vlastní MCP tooly | [MCP kompatibilita](docs/operations/mcp-compatibility.md) |
| Prezentační pluginy a jejich chování | [Pluginy](docs/operations/approval-plugins.md) |

Health endpointy jsou `/health/live` a `/health/ready`. Aplikace podporuje
jeden zapisující proces nad jedním datovým adresářem. MCP Tasks se zatím
neinzerují; čekání na schválení probíhá v původním volání nástroje.

## Struktura projektu

```text
apps/server       HTTP server, přihlášení, OAuth, admin API, Web Push
apps/web          React GUI
packages/gateway  MCP brána a schvalovací workflow
packages/policy   pravidla, profily a vyhodnocení oprávnění
packages/*        kontrakty, úložiště, auditní journal, upstream klient a pluginy
pocs/             samostatné experimenty a testovací MCP
```
