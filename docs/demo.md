# Video ukázka

[Přehrát video (WebM)](media/approval-mcp-demo.webm)

Ukázka zachycuje skutečné GUI a lokální admin API. Začíná předem přihlášenou
testovací session; nahrávání nepředvádí passkey ani OAuth přihlášení.
Používá izolovaný dočasný datový adresář, vymyšlené kontakty, simulované MCP
odpovědi a ukázkový seznam push zařízení. Žádný upstream ani push provider se
nekontaktuje. Schvalovací workflow, zápis oprávnění, historie a jeho zobrazení
v aplikaci jsou skutečné.

## Scénář

1. Pojmenované upstreamy, popis a metadata pracovního a soukromého účtu.
2. Agent, jeho profil, pravidla a dva nezávislé timeouty.
3. Detail čekající zprávy s lidským názvem příjemce a úplným textem.
4. Volba celého nástroje a schválení na hodinu bez podmínky na příjemce.
5. Nové oprávnění v Přístupech a další volání s jiným příjemcem bez nové výzvy.
6. Historie a detail průběhu volání.
7. Seznam notifikačních zařízení s tlačítky Test a Odebrat; samotné doručení
   systémové notifikace se nesimuluje ani nenahrává.

## Jak video znovu natočit

Z kořene repozitáře, s Node.js 24:

```bash
npm ci
npx playwright install chromium
npm run demo:record
```

Na Linuxu může být potřeba instalace systémových knihoven pro Chromium
pomocí `npx playwright install --with-deps chromium`. Nahrávání spouští pouze
lokální server na náhodném portu a po dokončení jej zastaví.

Výstupy jsou `docs/media/approval-mcp-demo.webm` a náhled
`docs/media/approval-mcp-demo.png`. Video je bez zvuku; jednotlivé části
uvádějí české titulky. WebM lze přehrát v prohlížeči nebo stáhnout.

Pro již nainstalovaný prohlížeč lze nastavit `DEMO_CHROMIUM_EXECUTABLE`;
`PLAYWRIGHT_BROWSERS_PATH` musí ukazovat i na instalaci Playwright FFmpeg.
Proměnná `DEMO_OUTPUT_DIR` umožňuje uložit výstupy jinam. `DEMO_SPEED` je
kladný násobek délky prezentačních pauz, například `0.1` pro rychlou kontrolu
scénáře. Standardní nahrávka používá hodnotu `1`.
